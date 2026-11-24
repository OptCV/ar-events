/**
 * Image-to-AR conversion steps (ADR-023, ADR-025). Plain functions over narrow dependencies so that the Cloudflare
 * Workflow (production, `vite dev`) and the inline runner (Node integration tests) execute exactly the same code.
 *
 * Steps: start → texture → glb → usdz → finish. The texture step decides what both files embed: the ORIGINAL bytes
 * when they can be embedded as-is (PNG/JPEG, upright, within the texture budget; ADR-009), otherwise a texture
 * prepared once by the converter (WebP → PNG/JPEG, EXIF rotation applied, downscaled to TEXTURE_MAX_EDGE) and stored
 * as an `image_object_texture` derivative, so the GLB (Worker) and USDZ (Container) embed identical bytes.
 *
 * Every step is idempotent: outputs are deterministic (same bytes + settings + converter → same bytes, ADR-011),
 * storage keys are derived from the provenance hash, and derivative rows are unique per provenance. A retried or
 * replayed step finds its previous output and reuses it instead of writing twice.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  TEXTURE_CONVERTER_VERSION,
  TEXTURE_MAX_EDGE,
  USD_CONVERTER_VERSION,
  type ConversionErrorCode,
  type ImageObjectSettings,
  type TextureInfo,
} from '@ar-creator/contracts';
import { schema, type Database } from '@ar-creator/db';
import { ImageFormatError, buildImagePlaneGlb, jpegOrientation, needsColorConversion, readImageInfo, resolveAlphaMode, scanPngAlpha, type AlphaStats } from '@ar-creator/image-to-ar';
import { CONVERTER_VERSION as GLB_BUILDER_VERSION, type ResolvedAlphaMode } from '@ar-creator/schema';
import type { ObjectStore } from '../assets/store.ts';
import { UsdConversionRejected, UsdConverterUnavailable, type UsdConverter } from './usd.ts';

const { assets, assetDerivatives, processingJobs } = schema;

/** Texture policy: part of every output's provenance, so outputs made under different texture rules never mix. */
export const TEXTURE_POLICY = `${TEXTURE_CONVERTER_VERSION}/max${TEXTURE_MAX_EDGE}`;
/** Provenance versions recorded on GLB and USDZ derivatives (and in the job input). */
export const GLB_CONVERTER_VERSION = `${GLB_BUILDER_VERSION}+${TEXTURE_POLICY}`;
export const USDZ_CONVERTER_VERSION = `${USD_CONVERTER_VERSION}+${TEXTURE_POLICY}`;

export const MIME_GLB = 'model/gltf-binary';
export const MIME_USDZ = 'model/vnd.usdz+zip';

export interface PipelineDeps {
  db: Database;
  store: ObjectStore;
  usd: UsdConverter;
}

/** A conversion failure with a user-facing message. `retryable` failures are retried by the Workflow. */
export class ConversionFailure extends Error {
  override name = 'ConversionFailure';
  readonly code: ConversionErrorCode;
  readonly retryable: boolean;
  constructor(code: ConversionErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/** The immutable job input stored in `processing_jobs.input`. */
export interface ImageObjectJobInput {
  kind: 'image-object';
  settings: ImageObjectSettings;
  settingsHash: string;
  glbConverterVersion: string;
  usdConverterVersion: string;
}

export interface JobContext {
  jobId: string;
  ownerId: string;
  assetId: string;
  input: ImageObjectJobInput;
  source: { r2Key: string; sha256: string; sizeBytes: number; mimeType: string };
}

export interface OutputRef {
  id: string;
  sha256: string;
  sizeBytes: number;
}

/** What GLB and USDZ embed: the original object, or a prepared texture derivative. Small and serialisable. */
export interface TextureRef extends TextureInfo {
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  /** null when the original bytes are embedded unchanged. */
  derivativeId: string | null;
}

export interface GlbStepResult {
  alphaMode: ResolvedAlphaMode;
  widthMeters: number;
  heightMeters: number;
  alpha: { pixels: number; transparentPixels: number; fractionalPixels: number } | null;
  texture: TextureInfo;
  glb: OutputRef;
}

export interface UsdzStepResult {
  usdz: OutputRef;
  validationWarnings: string[];
  openusdValidatorsRun: number;
}

type DerivativeType = 'image_object_glb' | 'image_object_usdz' | 'image_object_texture';

// ---------------------------------------------------------------- hashing / keys

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Canonical JSON (fixed key order, parsed defaults applied) so equal settings always hash equally. */
export function canonicalSettings(s: ImageObjectSettings): string {
  return JSON.stringify({
    widthMeters: s.widthMeters,
    shapeMode: s.shapeMode,
    alphaMode: s.alphaMode,
    alphaCutoff: s.alphaCutoff,
    doubleSided: s.doubleSided,
    pivot: s.pivot,
    orientation: s.orientation,
  });
}

export const settingsHash = (s: ImageObjectSettings) => sha256Hex(canonicalSettings(s));

/** Texture derivatives depend only on the source and the texture budget, not on the user's settings. */
const TEXTURE_SETTINGS = { maxEdge: TEXTURE_MAX_EDGE };
const textureSettingsHash = () => sha256Hex(JSON.stringify(TEXTURE_SETTINGS));

/**
 * `processing_jobs.idempotency_key`: one job per source × settings × converter versions. The versions are folded
 * into a short digest so the key stays well under its 200-character limit.
 */
export async function imageObjectJobKey(assetId: string, hash: string): Promise<string> {
  const versions = (await sha256Hex(`${GLB_CONVERTER_VERSION}|${USDZ_CONVERTER_VERSION}`)).slice(0, 16);
  return `i2a:${assetId}:${hash}:${versions}`;
}

const SAFE_OWNER = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DATA_MODEL.md layout: users/{uid}/assets/{assetId}/derivatives/{hash}/display.{ext}; hash covers settings + converter. */
export async function derivativeKey(ownerId: string, assetId: string, hash: string, converterVersion: string, ext: 'glb' | 'usdz' | 'png' | 'jpg'): Promise<string> {
  if (!SAFE_OWNER.test(ownerId) || !UUID.test(assetId) || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('unsafe storage key component');
  const provenance = await sha256Hex(`${hash}\n${converterVersion}`);
  return `users/${ownerId}/assets/${assetId}/derivatives/${provenance}/${ext === 'png' || ext === 'jpg' ? 'texture' : 'display'}.${ext}`;
}

// ---------------------------------------------------------------- steps

/** Load the job, mark it running and check the source is still usable. */
export async function startJob(deps: PipelineDeps, jobId: string): Promise<JobContext> {
  const [job] = await deps.db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  if (!job || job.type !== 'convert_image_to_ar' || !job.assetId) throw new ConversionFailure('internal', 'The conversion job does not exist.');
  const input = job.input as ImageObjectJobInput | null;
  if (!input || input.kind !== 'image-object') throw new ConversionFailure('internal', 'The conversion job has no input.');
  // A job recorded under other converter versions must not be finished by this code (its outputs would be mislabelled).
  if (input.glbConverterVersion !== GLB_CONVERTER_VERSION || input.usdConverterVersion !== USDZ_CONVERTER_VERSION) {
    throw new ConversionFailure('internal', 'This conversion was created by an older version. Start it again.');
  }
  await deps.db
    .update(processingJobs)
    .set({ state: 'running', startedAt: sql`coalesce(${processingJobs.startedAt}, now())`, updatedAt: new Date() })
    .where(and(eq(processingJobs.id, jobId), sql`${processingJobs.state} IN ('queued', 'running')`));
  const [a] = await deps.db
    .select()
    .from(assets)
    .where(and(eq(assets.id, job.assetId), eq(assets.ownerId, job.ownerId)))
    .limit(1);
  if (!a || a.state !== 'validated' || a.role !== 'display-image' || !a.sha256 || !a.mimeType || a.sizeBytes === null) {
    throw new ConversionFailure('source_unavailable', 'The source image is no longer available.');
  }
  return { jobId, ownerId: job.ownerId, assetId: a.id, input, source: { r2Key: a.r2Key, sha256: a.sha256, sizeBytes: a.sizeBytes, mimeType: a.mimeType } };
}

/** Read an object and insist it is exactly what was recorded (size and SHA-256). */
async function readVerified(deps: PipelineDeps, ref: { r2Key: string; sha256: string; sizeBytes: number }, what: string): Promise<Uint8Array> {
  const obj = await deps.store.get(ref.r2Key);
  if (!obj) throw new ConversionFailure('source_unavailable', `The ${what} is missing from storage.`);
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  if (bytes.length !== ref.sizeBytes || (await sha256Hex(bytes)) !== ref.sha256) {
    throw new ConversionFailure('source_unavailable', `The stored ${what} does not match its checksum.`);
  }
  return bytes;
}

const readSource = (deps: PipelineDeps, ctx: JobContext) => readVerified(deps, ctx.source, 'source image');
const readTexture = (deps: PipelineDeps, tex: TextureRef) => readVerified(deps, tex, tex.derivativeId ? 'prepared texture' : 'source image');

async function readyDerivative(deps: PipelineDeps, ctx: JobContext, outputType: DerivativeType, hash: string, converterVersion: string) {
  const [d] = await deps.db
    .select()
    .from(assetDerivatives)
    .where(
      and(
        eq(assetDerivatives.sourceAssetId, ctx.assetId),
        eq(assetDerivatives.outputType, outputType),
        eq(assetDerivatives.settingsHash, hash),
        eq(assetDerivatives.converterVersion, converterVersion),
      ),
    )
    .limit(1);
  return d?.status === 'ready' && d.sha256 && d.sizeBytes !== null && d.r2Key ? d : null;
}

/** Row first (pending, deterministic key), then the object, then `ready`: a failure never leaves a ready row without bytes. */
async function writeDerivative(
  deps: PipelineDeps,
  ctx: JobContext,
  w: { outputType: DerivativeType; hash: string; settings: unknown; converterVersion: string; ext: 'glb' | 'usdz' | 'png' | 'jpg' },
  bytes: Uint8Array,
  contentType: string,
  diagnostics: Record<string, unknown>,
): Promise<OutputRef & { r2Key: string }> {
  const key = await derivativeKey(ctx.ownerId, ctx.assetId, w.hash, w.converterVersion, w.ext);
  const sha = await sha256Hex(bytes);
  const match = and(
    eq(assetDerivatives.sourceAssetId, ctx.assetId),
    eq(assetDerivatives.outputType, w.outputType),
    eq(assetDerivatives.settingsHash, w.hash),
    eq(assetDerivatives.converterVersion, w.converterVersion),
  );
  await deps.db
    .insert(assetDerivatives)
    .values({ sourceAssetId: ctx.assetId, outputType: w.outputType, status: 'pending', settings: w.settings, settingsHash: w.hash, converterVersion: w.converterVersion, r2Key: key })
    .onConflictDoNothing({ target: [assetDerivatives.sourceAssetId, assetDerivatives.outputType, assetDerivatives.settingsHash, assetDerivatives.converterVersion] });
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  await deps.store.put(key, body, { size: bytes.length, contentType, sha256Hex: sha });
  const [row] = await deps.db.update(assetDerivatives).set({ status: 'ready', r2Key: key, sha256: sha, sizeBytes: bytes.length, diagnostics }).where(match).returning({ id: assetDerivatives.id });
  if (!row) throw new ConversionFailure('source_unavailable', 'The source image was deleted during conversion.');
  return { id: row.id, sha256: sha, sizeBytes: bytes.length, r2Key: key };
}

function asConverterFailure(e: unknown, what: string): never {
  if (e instanceof UsdConversionRejected) throw new ConversionFailure(what === 'texture' ? 'unsupported_image' : 'converter_failed', `The ${what === 'texture' ? 'image could not be prepared' : 'USDZ converter refused this image'}: ${e.message}.`);
  if (e instanceof UsdConverterUnavailable) throw new ConversionFailure('converter_unavailable', 'The converter is not available right now.', true);
  throw e;
}

/** Decide what both files embed; prepare (and store) a texture only when the original cannot be embedded as-is. */
export async function prepareTextureStep(deps: PipelineDeps, ctx: JobContext): Promise<TextureRef> {
  const bytes = await readSource(deps, ctx);
  let info;
  try {
    info = readImageInfo(bytes);
  } catch (e) {
    if (e instanceof ImageFormatError) throw new ConversionFailure('unsupported_image', `The image could not be read: ${e.message}.`);
    throw e;
  }
  const rotated = info.mime === 'image/jpeg' && jpegOrientation(bytes) !== 1;
  // ADR-039: a non-sRGB colour profile would be ignored by the viewers, so such images are converted to sRGB.
  const needs = info.mime === 'image/webp' || rotated || Math.max(info.width, info.height) > TEXTURE_MAX_EDGE || (await needsColorConversion(bytes));
  if (!needs) {
    // ADR-009: embed the uploaded bytes unmodified.
    return {
      r2Key: ctx.source.r2Key,
      sha256: ctx.source.sha256,
      sizeBytes: ctx.source.sizeBytes,
      derivativeId: null,
      mimeType: info.mime as 'image/png' | 'image/jpeg',
      width: info.width,
      height: info.height,
      sourceWidth: info.width,
      sourceHeight: info.height,
      changes: [],
    };
  }
  const hash = await textureSettingsHash();
  const existing = await readyDerivative(deps, ctx, 'image_object_texture', hash, TEXTURE_CONVERTER_VERSION);
  if (existing) {
    return { ...(existing.diagnostics as TextureInfo), r2Key: existing.r2Key!, sha256: existing.sha256!, sizeBytes: existing.sizeBytes!, derivativeId: existing.id };
  }
  let r;
  try {
    r = await deps.usd.prepareTexture(bytes, TEXTURE_MAX_EDGE, ctx.source.sha256);
  } catch (e) {
    asConverterFailure(e, 'texture');
  }
  if (r.converterVersion !== TEXTURE_CONVERTER_VERSION) throw new ConversionFailure('output_mismatch', `Unexpected texture converter version ${r.converterVersion}.`);
  if ((await sha256Hex(r.bytes)) !== r.sha256) throw new ConversionFailure('converter_unavailable', 'The prepared texture arrived damaged.', true);
  // Trust nothing the converter says about the result: re-read its header.
  const out = readImageInfo(r.bytes);
  if (out.mime !== r.mimeType || out.width !== r.width || out.height !== r.height || Math.max(out.width, out.height) > TEXTURE_MAX_EDGE) {
    throw new ConversionFailure('output_mismatch', 'The prepared texture does not match its description.');
  }
  const tex: TextureInfo = { mimeType: r.mimeType, width: r.width, height: r.height, sourceWidth: r.sourceWidth, sourceHeight: r.sourceHeight, changes: r.changes };
  const saved = await writeDerivative(
    deps,
    ctx,
    { outputType: 'image_object_texture', hash, settings: TEXTURE_SETTINGS, converterVersion: TEXTURE_CONVERTER_VERSION, ext: r.mimeType === 'image/png' ? 'png' : 'jpg' },
    r.bytes,
    r.mimeType,
    tex,
  );
  return { ...tex, r2Key: saved.r2Key, sha256: saved.sha256, sizeBytes: saved.sizeBytes, derivativeId: saved.id };
}

const textureInfo = (t: TextureRef): TextureInfo => ({ mimeType: t.mimeType, width: t.width, height: t.height, sourceWidth: t.sourceWidth, sourceHeight: t.sourceHeight, changes: t.changes });

/** Analyse alpha, resolve the alpha mode once (ADR-009) and build the GLB in the Worker. */
export async function buildGlbStep(deps: PipelineDeps, ctx: JobContext, tex: TextureRef): Promise<GlbStepResult> {
  const existing = await readyDerivative(deps, ctx, 'image_object_glb', ctx.input.settingsHash, GLB_CONVERTER_VERSION);
  if (existing?.diagnostics) {
    const d = existing.diagnostics as Omit<GlbStepResult, 'glb'>;
    return { alphaMode: d.alphaMode, widthMeters: d.widthMeters, heightMeters: d.heightMeters, alpha: d.alpha, texture: d.texture, glb: { id: existing.id, sha256: existing.sha256!, sizeBytes: existing.sizeBytes! } };
  }
  const bytes = await readTexture(deps, tex);
  let stats: AlphaStats | null = null;
  if (tex.mimeType === 'image/png') {
    try {
      stats = await scanPngAlpha(bytes);
    } catch (e) {
      if (e instanceof ImageFormatError) throw new ConversionFailure('unsupported_image', `The image could not be read: ${e.message}.`);
      throw e;
    }
  }
  let alphaMode: ResolvedAlphaMode;
  try {
    alphaMode = resolveAlphaMode(ctx.input.settings.alphaMode, stats);
  } catch {
    throw new ConversionFailure('invalid_settings', 'This image has transparent pixels, so it cannot be made fully opaque. Choose Auto, Cutout or Blend.');
  }
  const built = buildImagePlaneGlb({ image: bytes, settings: ctx.input.settings, alphaMode, name: 'image-object' });
  const alpha = stats ? { pixels: stats.pixels, transparentPixels: stats.transparent, fractionalPixels: stats.fractional } : null;
  const summary = { alphaMode, widthMeters: built.widthMeters, heightMeters: built.heightMeters, alpha, texture: textureInfo(tex) };
  const glb = await writeDerivative(
    deps,
    ctx,
    { outputType: 'image_object_glb', hash: ctx.input.settingsHash, settings: ctx.input.settings, converterVersion: GLB_CONVERTER_VERSION, ext: 'glb' },
    built.glb,
    MIME_GLB,
    summary,
  );
  return { ...summary, glb: { id: glb.id, sha256: glb.sha256, sizeBytes: glb.sizeBytes } };
}

/** Ask the OpenUSD converter for the matching USDZ (same texture bytes) and check it agrees with the GLB. */
export async function buildUsdzStep(deps: PipelineDeps, ctx: JobContext, tex: TextureRef, glb: GlbStepResult): Promise<UsdzStepResult> {
  const existing = await readyDerivative(deps, ctx, 'image_object_usdz', ctx.input.settingsHash, USDZ_CONVERTER_VERSION);
  if (existing) {
    const d = (existing.diagnostics ?? {}) as { validationWarnings?: string[]; openusdValidatorsRun?: number };
    return { usdz: { id: existing.id, sha256: existing.sha256!, sizeBytes: existing.sizeBytes! }, validationWarnings: d.validationWarnings ?? [], openusdValidatorsRun: d.openusdValidatorsRun ?? 0 };
  }
  const bytes = await readTexture(deps, tex);
  const s = ctx.input.settings;
  let r;
  try {
    r = await deps.usd.imagePlane(bytes, { widthMeters: s.widthMeters, alphaMode: glb.alphaMode, alphaCutoff: s.alphaCutoff, doubleSided: s.doubleSided, pivot: s.pivot, orientation: s.orientation }, tex.sha256);
  } catch (e) {
    asConverterFailure(e, 'usdz');
  }
  // Same quad on both platforms (ADR-005): dimensions and alpha mode must agree exactly.
  if (Math.abs(r.widthMeters - glb.widthMeters) > 1e-9 || Math.abs(r.heightMeters - glb.heightMeters) > 1e-9 || r.alphaMode !== glb.alphaMode) {
    throw new ConversionFailure('output_mismatch', 'The GLB and USDZ outputs disagree; nothing was saved.');
  }
  if (r.converterVersion !== USD_CONVERTER_VERSION) throw new ConversionFailure('output_mismatch', `Unexpected USDZ converter version ${r.converterVersion}.`);
  if ((await sha256Hex(r.usdz)) !== r.sha256) throw new ConversionFailure('converter_unavailable', 'The USDZ arrived damaged.', true);
  const diagnostics = { validationWarnings: r.validationWarnings, openusdValidatorsRun: r.openusdValidatorsRun, packageFiles: r.packageFiles };
  const usdz = await writeDerivative(
    deps,
    ctx,
    { outputType: 'image_object_usdz', hash: ctx.input.settingsHash, settings: ctx.input.settings, converterVersion: USDZ_CONVERTER_VERSION, ext: 'usdz' },
    r.usdz,
    MIME_USDZ,
    diagnostics,
  );
  return { usdz: { id: usdz.id, sha256: usdz.sha256, sizeBytes: usdz.sizeBytes }, validationWarnings: r.validationWarnings, openusdValidatorsRun: r.openusdValidatorsRun };
}

export async function finishJob(deps: PipelineDeps, ctx: JobContext, glb: GlbStepResult, usdz: UsdzStepResult): Promise<void> {
  await deps.db
    .update(processingJobs)
    .set({
      state: 'succeeded',
      errorCode: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
      diagnostics: {
        alphaMode: glb.alphaMode,
        widthMeters: glb.widthMeters,
        heightMeters: glb.heightMeters,
        alpha: glb.alpha,
        texture: glb.texture,
        glbId: glb.glb.id,
        usdzId: usdz.usdz.id,
        usdzWarnings: usdz.validationWarnings,
      },
    })
    .where(eq(processingJobs.id, ctx.jobId));
}

export async function failJob(deps: Pick<PipelineDeps, 'db'>, jobId: string, code: ConversionErrorCode, message: string): Promise<void> {
  await deps.db
    .update(processingJobs)
    .set({ state: 'failed', errorCode: code, finishedAt: new Date(), updatedAt: new Date(), diagnostics: sql`coalesce(${processingJobs.diagnostics}, '{}'::jsonb) || ${JSON.stringify({ error: { code, message } })}::jsonb` })
    .where(and(eq(processingJobs.id, jobId), sql`${processingJobs.state} <> 'succeeded'`));
}

/** Normalise any thrown value into a user-safe failure (internals are logged, never shown). */
export function asFailure(e: unknown): ConversionFailure {
  if (e instanceof ConversionFailure) return e;
  return new ConversionFailure('internal', 'Something went wrong while converting. Try again.', true);
}

/** Run every step in order (inline runner; the Workflow runs the same steps with durable retries). */
export async function runConversion(deps: PipelineDeps, jobId: string): Promise<void> {
  try {
    const ctx = await startJob(deps, jobId);
    const tex = await prepareTextureStep(deps, ctx);
    const glb = await buildGlbStep(deps, ctx, tex);
    const usdz = await buildUsdzStep(deps, ctx, tex, glb);
    await finishJob(deps, ctx, glb, usdz);
  } catch (e) {
    const f = asFailure(e);
    await failJob(deps, jobId, f.code, f.message);
    if (f.code === 'internal') throw e;
  }
}

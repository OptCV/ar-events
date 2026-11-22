/**
 * Image-to-AR conversion steps (ADR-023). Plain functions over narrow dependencies so that the Cloudflare Workflow
 * (production, `vite dev`) and the inline runner (Node integration tests) execute exactly the same code.
 *
 * Every step is idempotent: outputs are deterministic (same bytes + settings + converter → same bytes, ADR-011),
 * storage keys are derived from the provenance hash, and derivative rows are unique per provenance. A retried or
 * replayed step finds its previous output and reuses it instead of writing twice.
 */
import { and, eq, sql } from 'drizzle-orm';
import { USD_CONVERTER_VERSION, type ConversionErrorCode, type ImageObjectSettings } from '@ar-creator/contracts';
import { schema, type Database } from '@ar-creator/db';
import { ImageFormatError, buildImagePlaneGlb, jpegOrientation, readImageInfo, resolveAlphaMode, scanPngAlpha, type AlphaStats } from '@ar-creator/image-to-ar';
import { CONVERTER_VERSION as GLB_CONVERTER_VERSION, type ResolvedAlphaMode } from '@ar-creator/schema';
import type { ObjectStore } from '../assets/store.ts';
import { UsdConversionRejected, UsdConverterUnavailable, type UsdConverter } from './usd.ts';

const { assets, assetDerivatives, processingJobs } = schema;

export { GLB_CONVERTER_VERSION };
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

export interface GlbStepResult {
  alphaMode: ResolvedAlphaMode;
  widthMeters: number;
  heightMeters: number;
  alpha: { pixels: number; transparentPixels: number; fractionalPixels: number } | null;
  glb: OutputRef;
}

export interface UsdzStepResult {
  usdz: OutputRef;
  validationWarnings: string[];
  openusdValidatorsRun: number;
}

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

/** `processing_jobs.idempotency_key`: one job per source × settings × converter pair. */
export const imageObjectJobKey = (assetId: string, hash: string) => `i2a:${assetId}:${hash}:${GLB_CONVERTER_VERSION}+${USD_CONVERTER_VERSION}`;

const SAFE_OWNER = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DATA_MODEL.md layout: users/{uid}/assets/{assetId}/derivatives/{hash}/display.{glb|usdz}; hash covers settings + converter. */
export async function derivativeKey(ownerId: string, assetId: string, hash: string, converterVersion: string, ext: 'glb' | 'usdz'): Promise<string> {
  if (!SAFE_OWNER.test(ownerId) || !UUID.test(assetId) || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('unsafe storage key component');
  const provenance = await sha256Hex(`${hash}\n${converterVersion}`);
  return `users/${ownerId}/assets/${assetId}/derivatives/${provenance}/display.${ext}`;
}

// ---------------------------------------------------------------- steps

/** Load the job, mark it running and check the source is still usable. */
export async function startJob(deps: PipelineDeps, jobId: string): Promise<JobContext> {
  const [job] = await deps.db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  if (!job || job.type !== 'convert_image_to_ar' || !job.assetId) throw new ConversionFailure('internal', 'The conversion job does not exist.');
  const input = job.input as ImageObjectJobInput | null;
  if (!input || input.kind !== 'image-object') throw new ConversionFailure('internal', 'The conversion job has no input.');
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

async function readSource(deps: PipelineDeps, ctx: JobContext): Promise<Uint8Array> {
  const obj = await deps.store.get(ctx.source.r2Key);
  if (!obj) throw new ConversionFailure('source_unavailable', 'The source image is missing from storage.');
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  // The stored bytes must still be exactly what was validated at upload time.
  if (bytes.length !== ctx.source.sizeBytes || (await sha256Hex(bytes)) !== ctx.source.sha256) {
    throw new ConversionFailure('source_unavailable', 'The stored source image does not match its checksum.');
  }
  return bytes;
}

async function readyDerivative(deps: PipelineDeps, ctx: JobContext, outputType: 'image_object_glb' | 'image_object_usdz', converterVersion: string) {
  const [d] = await deps.db
    .select()
    .from(assetDerivatives)
    .where(
      and(
        eq(assetDerivatives.sourceAssetId, ctx.assetId),
        eq(assetDerivatives.outputType, outputType),
        eq(assetDerivatives.settingsHash, ctx.input.settingsHash),
        eq(assetDerivatives.converterVersion, converterVersion),
      ),
    )
    .limit(1);
  return d ?? null;
}

/** Row first (pending, deterministic key), then the object, then `ready`: a failure never leaves a ready row without bytes. */
async function writeDerivative(
  deps: PipelineDeps,
  ctx: JobContext,
  outputType: 'image_object_glb' | 'image_object_usdz',
  converterVersion: string,
  bytes: Uint8Array,
  contentType: string,
  diagnostics: Record<string, unknown>,
): Promise<OutputRef> {
  const key = await derivativeKey(ctx.ownerId, ctx.assetId, ctx.input.settingsHash, converterVersion, outputType === 'image_object_glb' ? 'glb' : 'usdz');
  const sha = await sha256Hex(bytes);
  await deps.db
    .insert(assetDerivatives)
    .values({ sourceAssetId: ctx.assetId, outputType, status: 'pending', settings: ctx.input.settings, settingsHash: ctx.input.settingsHash, converterVersion, r2Key: key })
    .onConflictDoNothing({ target: [assetDerivatives.sourceAssetId, assetDerivatives.outputType, assetDerivatives.settingsHash, assetDerivatives.converterVersion] });
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  await deps.store.put(key, body, { size: bytes.length, contentType, sha256Hex: sha });
  const [row] = await deps.db
    .update(assetDerivatives)
    .set({ status: 'ready', r2Key: key, sha256: sha, sizeBytes: bytes.length, diagnostics })
    .where(
      and(
        eq(assetDerivatives.sourceAssetId, ctx.assetId),
        eq(assetDerivatives.outputType, outputType),
        eq(assetDerivatives.settingsHash, ctx.input.settingsHash),
        eq(assetDerivatives.converterVersion, converterVersion),
      ),
    )
    .returning({ id: assetDerivatives.id });
  if (!row) throw new ConversionFailure('source_unavailable', 'The source image was deleted during conversion.');
  return { id: row.id, sha256: sha, sizeBytes: bytes.length };
}

/** Analyse alpha, resolve the alpha mode once (ADR-009) and build the GLB in the Worker. */
export async function buildGlbStep(deps: PipelineDeps, ctx: JobContext): Promise<GlbStepResult> {
  const existing = await readyDerivative(deps, ctx, 'image_object_glb', GLB_CONVERTER_VERSION);
  if (existing?.status === 'ready' && existing.sha256 && existing.sizeBytes !== null && existing.diagnostics) {
    const d = existing.diagnostics as Omit<GlbStepResult, 'glb'>;
    return { alphaMode: d.alphaMode, widthMeters: d.widthMeters, heightMeters: d.heightMeters, alpha: d.alpha, glb: { id: existing.id, sha256: existing.sha256, sizeBytes: existing.sizeBytes } };
  }
  const bytes = await readSource(deps, ctx);
  let stats: AlphaStats | null = null;
  try {
    const info = readImageInfo(bytes);
    if (info.mime === 'image/jpeg') {
      const o = jpegOrientation(bytes);
      if (o !== 1) throw new ConversionFailure('unsupported_image', 'This photo is stored rotated (EXIF orientation). Rotate it in an image editor, export it again and upload the new file.');
    } else {
      stats = await scanPngAlpha(bytes);
    }
  } catch (e) {
    if (e instanceof ConversionFailure) throw e;
    if (e instanceof ImageFormatError) throw new ConversionFailure('unsupported_image', `The image could not be read: ${e.message}.`);
    throw e;
  }
  let alphaMode: ResolvedAlphaMode;
  try {
    alphaMode = resolveAlphaMode(ctx.input.settings.alphaMode, stats);
  } catch {
    throw new ConversionFailure('invalid_settings', 'This image has transparent pixels, so it cannot be made fully opaque. Choose Auto, Cutout or Blend.');
  }
  const built = buildImagePlaneGlb({ image: bytes, settings: ctx.input.settings, alphaMode, name: 'image-object' });
  const alpha = stats ? { pixels: stats.pixels, transparentPixels: stats.transparent, fractionalPixels: stats.fractional } : null;
  const summary = { alphaMode, widthMeters: built.widthMeters, heightMeters: built.heightMeters, alpha };
  const glb = await writeDerivative(deps, ctx, 'image_object_glb', GLB_CONVERTER_VERSION, built.glb, MIME_GLB, summary);
  return { ...summary, glb };
}

/** Ask the OpenUSD converter for the matching USDZ and check it agrees with the GLB. */
export async function buildUsdzStep(deps: PipelineDeps, ctx: JobContext, glb: GlbStepResult): Promise<UsdzStepResult> {
  const existing = await readyDerivative(deps, ctx, 'image_object_usdz', USD_CONVERTER_VERSION);
  if (existing?.status === 'ready' && existing.sha256 && existing.sizeBytes !== null) {
    const d = (existing.diagnostics ?? {}) as { validationWarnings?: string[]; openusdValidatorsRun?: number };
    return { usdz: { id: existing.id, sha256: existing.sha256, sizeBytes: existing.sizeBytes }, validationWarnings: d.validationWarnings ?? [], openusdValidatorsRun: d.openusdValidatorsRun ?? 0 };
  }
  const bytes = await readSource(deps, ctx);
  const s = ctx.input.settings;
  let r;
  try {
    r = await deps.usd.imagePlane(bytes, { widthMeters: s.widthMeters, alphaMode: glb.alphaMode, alphaCutoff: s.alphaCutoff, doubleSided: s.doubleSided, pivot: s.pivot, orientation: s.orientation }, ctx.source.sha256);
  } catch (e) {
    if (e instanceof UsdConversionRejected) throw new ConversionFailure('converter_failed', `The USDZ converter refused this image: ${e.message}.`);
    if (e instanceof UsdConverterUnavailable) throw new ConversionFailure('converter_unavailable', 'The USDZ converter is not available right now.', true);
    throw e;
  }
  // Same quad on both platforms (ADR-005): dimensions and alpha mode must agree exactly.
  if (Math.abs(r.widthMeters - glb.widthMeters) > 1e-9 || Math.abs(r.heightMeters - glb.heightMeters) > 1e-9 || r.alphaMode !== glb.alphaMode) {
    throw new ConversionFailure('output_mismatch', 'The GLB and USDZ outputs disagree; nothing was saved.');
  }
  if (r.converterVersion !== USD_CONVERTER_VERSION) throw new ConversionFailure('output_mismatch', `Unexpected USDZ converter version ${r.converterVersion}.`);
  if ((await sha256Hex(r.usdz)) !== r.sha256) throw new ConversionFailure('converter_unavailable', 'The USDZ arrived damaged.', true);
  const diagnostics = { validationWarnings: r.validationWarnings, openusdValidatorsRun: r.openusdValidatorsRun, packageFiles: r.packageFiles };
  const usdz = await writeDerivative(deps, ctx, 'image_object_usdz', USD_CONVERTER_VERSION, r.usdz, MIME_USDZ, diagnostics);
  return { usdz, validationWarnings: r.validationWarnings, openusdValidatorsRun: r.openusdValidatorsRun };
}

export async function finishJob(deps: PipelineDeps, ctx: JobContext, glb: GlbStepResult, usdz: UsdzStepResult): Promise<void> {
  await deps.db
    .update(processingJobs)
    .set({
      state: 'succeeded',
      errorCode: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
      diagnostics: { alphaMode: glb.alphaMode, widthMeters: glb.widthMeters, heightMeters: glb.heightMeters, alpha: glb.alpha, glbId: glb.glb.id, usdzId: usdz.usdz.id, usdzWarnings: usdz.validationWarnings },
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
    const glb = await buildGlbStep(deps, ctx);
    const usdz = await buildUsdzStep(deps, ctx, glb);
    await finishJob(deps, ctx, glb, usdz);
  } catch (e) {
    const f = asFailure(e);
    await failJob(deps, jobId, f.code, f.message);
    if (f.code === 'internal') throw e;
  }
}

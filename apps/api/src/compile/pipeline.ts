/**
 * Test builds (Phase 5 Milestone 16, ADR-034): compile a frozen snapshot of a draft into the files the AR viewers open.
 *
 * A build is an `experience_revisions` row (frozen, with a content hash over the scene, the files it uses and the
 * compiler versions) plus one `generated_outputs` row per platform: the composed GLB (Android: Scene Viewer or the
 * WebXR image viewer) and the anchored USDZ (iPhone: Quick Look). Steps — start → glb → usdz → finish — are idempotent
 * and shared by the Cloudflare Workflow and the inline test runner. A platform whose file the compiler refuses (e.g.
 * a compressed model on iPhone) is marked failed with a reason; the other platform still completes (partially_ready).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { BUILD_ERRORS, MAX_BUILD_INPUT_BYTES, SCENE_GLB_VERSION, SCENE_USDZ_VERSION, type BuildErrorCode } from '@ar-creator/contracts';
import { schema, type Database } from '@ar-creator/db';
import type { Runtime } from '@ar-creator/platform-launch';
import { ExperienceScene, publishReadiness, type DraftExperienceScene, type PlacementMode } from '@ar-creator/schema';
import type { ObjectStore } from '../assets/store.ts';
import { UsdConversionRejected, UsdConverterUnavailable, type UsdConverter } from '../conversions/usd.ts';
import { MIME_GLB, MIME_USDZ, sha256Hex } from '../conversions/pipeline.ts';
import { frameSceneRequest, sceneManifest } from './sceneRequest.ts';

const { assets, assetDerivatives, experienceRevisions, experiences, generatedOutputs, processingJobs } = schema;

export interface BuildDeps {
  db: Database;
  store: ObjectStore;
  usd: UsdConverter;
}

export class BuildFailure extends Error {
  override name = 'BuildFailure';
  readonly code: BuildErrorCode;
  readonly retryable: boolean;
  constructor(code: BuildErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export type Platform = 'ios' | 'android';
export const runtimeFor = (platform: Platform, mode: PlacementMode): Runtime =>
  platform === 'ios' ? `ios_quicklook_${mode}` : mode === 'image' ? 'android_webxr_image' : `android_scene_viewer_${mode}`;
export const platformOf = (runtime: string): Platform => (runtime.startsWith('ios_') ? 'ios' : 'android');

/** A file the compile request carries, with what it must be (re-checked when read). */
export interface BuildFile {
  fid: string;
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  ref: { type: 'image-object' | 'model' | 'tracking'; id: string };
}

export interface BuildJobInput {
  kind: 'build';
  contentHash: string;
  files: BuildFile[];
  glbVersion: string;
  usdzVersion: string;
}

// ---------------------------------------------------------------- planning (API, before a build exists)

export type BuildPlan =
  | { ok: true; scene: ExperienceScene; files: BuildFile[]; contentHash: string }
  | { ok: false; reason: 'not_ready'; message: string; issues: { path: (string | number)[]; message: string }[] };

/**
 * Resolve everything a draft needs to compile: the strict (publishable) scene, the image-object GLBs, model files and
 * tracking image it uses — owned, ready and unchanged — and the content hash that identifies the build.
 */
export async function planBuild(db: Database, ownerId: string, draft: DraftExperienceScene): Promise<BuildPlan> {
  // The same blocking checks as publishing (an empty scene, image placement without a tracking image, …).
  const readiness = publishReadiness(draft);
  const blocking = readiness.issues.filter((i) => i.severity === 'error');
  if (blocking.length) return { ok: false, reason: 'not_ready', message: blocking[0]!.message, issues: blocking.map((i) => ({ path: i.path, message: i.message })) };
  const strict = ExperienceScene.safeParse(draft);
  if (!strict.success) {
    return { ok: false, reason: 'not_ready', message: 'The scene is not ready to test yet.', issues: strict.error.issues.map((i) => ({ path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)), message: i.message })) };
  }
  const scene = strict.data;
  const visible = scene.nodes; // hidden nodes are skipped by the compiler, but their files must still be valid references
  const derivIds = [...new Set(visible.flatMap((n) => (n.kind === 'image-object' ? [n.derivativeId] : [])))];
  const assetIds = [...new Set(visible.flatMap((n) => (n.kind === 'model' ? [n.assetId] : [])))];
  const trackingId = scene.placement.mode === 'image' ? scene.placement.trackingTargetAssetId : null;
  const files: BuildFile[] = [];
  const issues: { path: (string | number)[]; message: string }[] = [];

  if (derivIds.length) {
    const rows = await db
      .select({ id: assetDerivatives.id, r2Key: assetDerivatives.r2Key, sha256: assetDerivatives.sha256, sizeBytes: assetDerivatives.sizeBytes })
      .from(assetDerivatives)
      .innerJoin(assets, eq(assets.id, assetDerivatives.sourceAssetId))
      .where(and(eq(assets.ownerId, ownerId), eq(assets.state, 'validated'), eq(assetDerivatives.outputType, 'image_object_glb'), eq(assetDerivatives.status, 'ready'), inArray(assetDerivatives.id, derivIds)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    derivIds.forEach((id, i) => {
      const r = byId.get(id);
      if (!r?.r2Key || !r.sha256 || r.sizeBytes === null) issues.push({ path: ['nodes'], message: 'An image object in the scene is no longer available.' });
      else files.push({ fid: `io${i}`, r2Key: r.r2Key, sha256: r.sha256, sizeBytes: r.sizeBytes, ref: { type: 'image-object', id } });
    });
  }
  const wantAssets = [...assetIds, ...(trackingId ? [trackingId] : [])];
  if (wantAssets.length) {
    const rows = await db
      .select({ id: assets.id, role: assets.role, r2Key: assets.r2Key, sha256: assets.sha256, sizeBytes: assets.sizeBytes })
      .from(assets)
      .where(and(eq(assets.ownerId, ownerId), eq(assets.state, 'validated'), inArray(assets.id, wantAssets)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    assetIds.forEach((id, i) => {
      const r = byId.get(id);
      if (!r || r.role !== 'model' || !r.sha256 || r.sizeBytes === null) issues.push({ path: ['nodes'], message: 'A 3D model in the scene is no longer available.' });
      else files.push({ fid: `m${i}`, r2Key: r.r2Key, sha256: r.sha256, sizeBytes: r.sizeBytes, ref: { type: 'model', id } });
    });
    if (trackingId) {
      const r = byId.get(trackingId);
      if (!r || r.role !== 'tracking-image' || !r.sha256 || r.sizeBytes === null) issues.push({ path: ['placement', 'trackingTargetAssetId'], message: 'The tracking image is no longer available.' });
      else files.push({ fid: 't', r2Key: r.r2Key, sha256: r.sha256, sizeBytes: r.sizeBytes, ref: { type: 'tracking', id: trackingId } });
    }
  }
  if (issues.length) return { ok: false, reason: 'not_ready', message: 'Some files the scene uses are no longer available.', issues };
  const total = files.reduce((n, f) => n + f.sizeBytes, 0);
  if (total > MAX_BUILD_INPUT_BYTES) {
    return { ok: false, reason: 'not_ready', message: `The files in this scene total ${(total / 1048576).toFixed(1)} MB; a test build can use up to ${MAX_BUILD_INPUT_BYTES / 1048576} MB.`, issues: [] };
  }
  const contentHash = await sha256Hex(
    JSON.stringify({
      scene,
      files: files.map((f) => ({ ref: f.ref, sha256: f.sha256 })).sort((a, b) => `${a.ref.type}:${a.ref.id}`.localeCompare(`${b.ref.type}:${b.ref.id}`)),
      compilers: [SCENE_GLB_VERSION, SCENE_USDZ_VERSION],
    }),
  );
  return { ok: true, scene, files, contentHash };
}

// ---------------------------------------------------------------- steps

export interface BuildContext {
  jobId: string;
  ownerId: string;
  experienceId: string;
  revisionId: string;
  mode: PlacementMode;
  scene: ExperienceScene;
  input: BuildJobInput;
}

export interface OutputResult {
  platform: Platform;
  state: 'ready' | 'failed';
  code?: BuildErrorCode;
}

export async function startBuild(deps: BuildDeps, jobId: string): Promise<BuildContext> {
  const [job] = await deps.db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  if (!job || job.type !== 'compile_revision' || !job.revisionId) throw new BuildFailure('internal', 'The build job does not exist.');
  const input = job.input as BuildJobInput | null;
  if (!input || input.kind !== 'build') throw new BuildFailure('internal', 'The build job has no input.');
  if (input.glbVersion !== SCENE_GLB_VERSION || input.usdzVersion !== SCENE_USDZ_VERSION) throw new BuildFailure('internal', 'This build was created by an older version. Build again.');
  const [rev] = await deps.db.select().from(experienceRevisions).where(eq(experienceRevisions.id, job.revisionId)).limit(1);
  if (!rev) throw new BuildFailure('internal', 'The build does not exist.');
  const scene = ExperienceScene.parse(rev.config);
  await deps.db
    .update(processingJobs)
    .set({ state: 'running', startedAt: sql`coalesce(${processingJobs.startedAt}, now())`, updatedAt: new Date() })
    .where(and(eq(processingJobs.id, jobId), sql`${processingJobs.state} IN ('queued', 'running')`));
  await deps.db.update(experienceRevisions).set({ state: 'compiling' }).where(and(eq(experienceRevisions.id, rev.id), sql`${experienceRevisions.state} IN ('snapshot', 'compiling', 'failed', 'partially_ready')`));
  return { jobId, ownerId: job.ownerId, experienceId: rev.experienceId, revisionId: rev.id, mode: scene.placement.mode, scene, input };
}

async function readFile(deps: BuildDeps, f: BuildFile): Promise<Uint8Array> {
  const obj = await deps.store.get(f.r2Key);
  if (!obj) throw new BuildFailure('files_unavailable', 'A file the scene uses is missing from storage.');
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  if (bytes.length !== f.sizeBytes || (await sha256Hex(bytes)) !== f.sha256) throw new BuildFailure('files_unavailable', 'A file the scene uses has changed since the build started.');
  return bytes;
}

export async function compileRequest(deps: BuildDeps, ctx: BuildContext): Promise<Uint8Array> {
  const files = await Promise.all(ctx.input.files.map(async (f) => ({ id: f.fid, data: await readFile(deps, f) })));
  const ref = (type: BuildFile['ref']['type'], id: string) => ctx.input.files.find((f) => f.ref.type === type && f.ref.id === id)?.fid ?? null;
  const tracking = ctx.input.files.find((f) => f.ref.type === 'tracking')?.fid;
  const manifest = sceneManifest(ctx.scene, { imageObject: (id) => ref('image-object', id), model: (id) => ref('model', id), ...(tracking ? { tracking } : {}) });
  return frameSceneRequest(manifest, files);
}

export function buildKey(ctx: Pick<BuildContext, 'ownerId' | 'experienceId' | 'input'>, format: 'glb' | 'usdz'): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ctx.ownerId) || !/^[0-9a-f-]{36}$/.test(ctx.experienceId) || !/^[0-9a-f]{64}$/.test(ctx.input.contentHash)) throw new Error('unsafe storage key component');
  return `users/${ctx.ownerId}/experiences/${ctx.experienceId}/builds/${ctx.input.contentHash}/scene.${format}`;
}

const REJECTION: Record<string, BuildErrorCode> = {
  empty_scene: 'empty_scene',
  too_large: 'too_large',
  unsupported_model: 'unsupported_model',
  bad_file: 'bad_file',
  tracking_image_missing: 'tracking_image_missing',
  validation_failed: 'validation_failed',
};

/**
 * Compile one platform's file and store it. A refusal the user can act on marks only this output failed (the other
 * platform continues); an unreachable converter is retried by the Workflow.
 */
export async function compileOutputStep(deps: BuildDeps, ctx: BuildContext, platform: Platform): Promise<OutputResult> {
  const runtime = runtimeFor(platform, ctx.mode);
  const where = and(eq(generatedOutputs.revisionId, ctx.revisionId), eq(generatedOutputs.runtime, runtime));
  const [existing] = await deps.db.select().from(generatedOutputs).where(where).limit(1);
  if (!existing) throw new BuildFailure('internal', 'The build has no output for this platform.');
  if (existing.state === 'ready') return { platform, state: 'ready' };
  const format = platform === 'ios' ? 'usdz' : 'glb';
  const version = format === 'glb' ? SCENE_GLB_VERSION : SCENE_USDZ_VERSION;
  const request = await compileRequest(deps, ctx);
  let out;
  try {
    out = await deps.usd.scene(format, request, await sha256Hex(request));
  } catch (e) {
    if (e instanceof UsdConverterUnavailable) throw new BuildFailure('converter_unavailable', 'The compiler is not available right now.', true);
    if (e instanceof UsdConversionRejected) {
      const code = REJECTION[e.code] ?? 'internal';
      await deps.db.update(generatedOutputs).set({ state: 'failed', validation: { error: { code, message: e.message } } }).where(where);
      return { platform, state: 'failed', code };
    }
    throw e;
  }
  if (out.compilerVersion !== version) throw new BuildFailure('output_mismatch', `Unexpected compiler version ${out.compilerVersion}.`);
  const sha = await sha256Hex(out.bytes);
  if (sha !== out.sha256) throw new BuildFailure('converter_unavailable', 'The compiled file arrived damaged.', true);
  const key = buildKey(ctx, format);
  await deps.db.update(generatedOutputs).set({ r2Key: key, mimeType: format === 'glb' ? MIME_GLB : MIME_USDZ }).where(where);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(out.bytes);
      c.close();
    },
  });
  await deps.store.put(key, body, { size: out.bytes.length, contentType: format === 'glb' ? MIME_GLB : MIME_USDZ, sha256Hex: sha });
  await deps.db
    .update(generatedOutputs)
    .set({ state: 'ready', r2Key: key, sha256: sha, sizeBytes: out.bytes.length, validation: { warnings: out.warnings, compilerVersion: out.compilerVersion } })
    .where(where);
  return { platform, state: 'ready' };
}

// ---------------------------------------------------------------- publishing (Phase 6 M18, ADR-036)

/** A publish request waiting for its build, kept on the build's lifecycle field (the scene itself is frozen). */
export interface PublishIntent {
  publishRequested?: boolean;
  publishFailed?: { message: string; at: string };
}

/**
 * Make a READY build the live version: the previous live build becomes `superseded`, this one `published`, and the
 * experience points at it — in one transaction, so visitors always get one complete version. Anything that is not a
 * ready build of this experience is refused (returns false): the live version stays as it was.
 */
export async function promoteBuild(db: Database, experienceId: string, revisionId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [rev] = await tx.select().from(experienceRevisions).where(and(eq(experienceRevisions.id, revisionId), eq(experienceRevisions.experienceId, experienceId))).limit(1);
    if (!rev?.contentHash || (rev.state !== 'ready' && rev.state !== 'published')) return false;
    const [e] = await tx.select({ live: experiences.publishedRevisionId }).from(experiences).where(eq(experiences.id, experienceId)).for('update').limit(1);
    if (!e) return false;
    if (e.live && e.live !== revisionId) await tx.update(experienceRevisions).set({ state: 'superseded' }).where(eq(experienceRevisions.id, e.live));
    await tx.update(experienceRevisions).set({ state: 'published', validationReport: { publishRequested: false } }).where(eq(experienceRevisions.id, revisionId));
    await tx.update(experiences).set({ publishedRevisionId: revisionId, visibility: 'public', updatedAt: new Date() }).where(eq(experiences.id, experienceId));
    return true;
  });
}

export async function finishBuild(deps: Pick<BuildDeps, 'db'>, ctx: BuildContext, results: OutputResult[]): Promise<void> {
  const ready = results.filter((r) => r.state === 'ready').length;
  const state = ready === results.length ? 'ready' : ready > 0 ? 'partially_ready' : 'failed';
  await deps.db.update(experienceRevisions).set({ state }).where(eq(experienceRevisions.id, ctx.revisionId));
  // Publish requested while building: promote only a complete build; otherwise the live version stays (gate).
  const [rev] = await deps.db.select({ report: experienceRevisions.validationReport }).from(experienceRevisions).where(eq(experienceRevisions.id, ctx.revisionId)).limit(1);
  if ((rev?.report as PublishIntent | null)?.publishRequested) {
    if (state === 'ready') await promoteBuild(deps.db, ctx.experienceId, ctx.revisionId);
    else {
      const failed = results.find((r) => r.state === 'failed');
      const intent: PublishIntent = { publishRequested: false, publishFailed: { message: `Not published: the ${failed?.platform === 'ios' ? 'iPhone' : 'Android'} file could not be made. The live version is unchanged.`, at: new Date().toISOString() } };
      await deps.db.update(experienceRevisions).set({ validationReport: intent }).where(eq(experienceRevisions.id, ctx.revisionId));
    }
  }
  const failed = results.find((r) => r.state === 'failed');
  await deps.db
    .update(processingJobs)
    .set({
      state: state === 'failed' ? 'failed' : 'succeeded',
      errorCode: state === 'failed' ? (failed?.code ?? 'internal') : null,
      finishedAt: new Date(),
      updatedAt: new Date(),
      diagnostics: { results },
    })
    .where(eq(processingJobs.id, ctx.jobId));
}

export async function failBuild(deps: Pick<BuildDeps, 'db'>, jobId: string, code: BuildErrorCode, message: string): Promise<void> {
  const [job] = await deps.db.select({ revisionId: processingJobs.revisionId }).from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  if (job?.revisionId) {
    const [rev] = await deps.db.select({ report: experienceRevisions.validationReport }).from(experienceRevisions).where(eq(experienceRevisions.id, job.revisionId)).limit(1);
    if ((rev?.report as PublishIntent | null)?.publishRequested) {
      await deps.db
        .update(experienceRevisions)
        .set({ validationReport: { publishRequested: false, publishFailed: { message: `Not published: ${message} The live version is unchanged.`, at: new Date().toISOString() } } satisfies PublishIntent })
        .where(eq(experienceRevisions.id, job.revisionId));
    }
    await deps.db
      .update(generatedOutputs)
      .set({ state: 'failed', validation: { error: { code, message } } })
      .where(and(eq(generatedOutputs.revisionId, job.revisionId), eq(generatedOutputs.state, 'pending')));
    await deps.db.update(experienceRevisions).set({ state: 'failed' }).where(eq(experienceRevisions.id, job.revisionId));
  }
  await deps.db
    .update(processingJobs)
    .set({ state: 'failed', errorCode: code, finishedAt: new Date(), updatedAt: new Date(), diagnostics: sql`coalesce(${processingJobs.diagnostics}, '{}'::jsonb) || ${JSON.stringify({ error: { code, message } })}::jsonb` })
    .where(and(eq(processingJobs.id, jobId), sql`${processingJobs.state} <> 'succeeded'`));
}

export function asBuildFailure(e: unknown): BuildFailure {
  if (e instanceof BuildFailure) return e;
  return new BuildFailure('internal', 'Something went wrong while building. Try again.', true);
}

export const isBuildError = (code: string): code is BuildErrorCode => (BUILD_ERRORS as readonly string[]).includes(code);

/** Inline runner: every step in order (the Workflow runs the same steps with durable retries). */
export async function runBuild(deps: BuildDeps, jobId: string): Promise<void> {
  try {
    const ctx = await startBuild(deps, jobId);
    const results = [await compileOutputStep(deps, ctx, 'android'), await compileOutputStep(deps, ctx, 'ios')];
    await finishBuild(deps, ctx, results);
  } catch (e) {
    const f = asBuildFailure(e);
    await failBuild(deps, jobId, f.code, f.message);
    if (f.code === 'internal') throw e;
  }
}

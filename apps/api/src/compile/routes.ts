/**
 * Test builds and device test links (Phase 5 Milestone 16, ADR-034).
 *
 *   POST /api/experiences/:id/builds          compile the current draft (reuses an identical build)
 *   GET  /api/experiences/:id/builds/latest   the newest build, with a fresh test link when usable
 *   GET  /api/test-builds/:id?v&exp&sig       PUBLIC (signed test link): what the device test page needs
 *   GET  /api/outputs/:id/content?v&exp&sig   PUBLIC (signed): a compiled file, cookieless, for Quick Look / Scene Viewer
 */
import { Hono, type Context } from 'hono';
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import {
  ASSET_LIMITS,
  MAX_ACTIVE_BUILDS,
  SCENE_GLB_VERSION,
  SCENE_USDZ_VERSION,
  TEST_LINK_TTL_SECONDS,
  type BuildErrorCode,
  type BuildOutput,
  type BuildSummary,
  type TestBuildResponse,
} from '@ar-creator/contracts';
import { buttonLabel, pagePlan, planInteractions } from '@ar-creator/capabilities';
import { schema, type Database } from '@ar-creator/db';
import { DraftExperienceScene, ExperienceScene } from '@ar-creator/schema';
import type { AppEnv } from '../app.ts';
import { requireSession } from '../auth/middleware.ts';
import { assetSigningKey, signAssetUrl, verifyAssetUrl } from '../assets/signing.ts';
import { err } from '../http.ts';
import { logError } from '../db.ts';
import { MIME_GLB, MIME_USDZ } from '../conversions/pipeline.ts';
import { isBuildError, planBuild, platformOf, runtimeFor, type BuildJobInput } from './pipeline.ts';

const { assets, experienceRevisions, experiences, generatedOutputs, processingJobs } = schema;
type RevisionRow = typeof experienceRevisions.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const signingSecret = (c: Context<AppEnv>) => {
  const s = c.get('authConfig').secret;
  return s && s.length >= 32 ? s : null;
};
const appOrigin = (c: Context<AppEnv>) => c.get('authConfig').baseURL ?? new URL(c.req.url).origin;
const notFound = (c: Context<AppEnv>) => err(c, 404, 'not_found', 'Not found.');

async function ownedExperience(db: Database, id: string, ownerId: string) {
  if (!UUID.test(id)) return null;
  const [row] = await db
    .select({ e: experiences, draft: experienceRevisions })
    .from(experiences)
    .innerJoin(experienceRevisions, eq(experienceRevisions.id, experiences.draftRevisionId))
    .where(and(eq(experiences.id, id), eq(experiences.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

async function summarize(c: Context<AppEnv>, db: Database, rev: RevisionRow, currentHash: string | null): Promise<BuildSummary> {
  const [job] = await db.select().from(processingJobs).where(eq(processingJobs.revisionId, rev.id)).orderBy(desc(processingJobs.createdAt)).limit(1);
  const outs = await db.select().from(generatedOutputs).where(eq(generatedOutputs.revisionId, rev.id));
  const outputs: BuildOutput[] = outs
    .map((o) => {
      const v = (o.validation ?? {}) as { warnings?: string[]; error?: { code: string; message: string } };
      const platform = platformOf(o.runtime);
      return {
        id: o.id,
        platform,
        runtime: o.runtime,
        format: platform === 'ios' ? ('usdz' as const) : ('glb' as const),
        state: o.state,
        sizeBytes: o.sizeBytes,
        sha256: o.sha256,
        warnings: v.warnings ?? [],
        error: v.error && isBuildError(v.error.code) ? { code: v.error.code, message: v.error.message } : null,
      };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));
  const state: BuildSummary['state'] =
    rev.state === 'ready' || rev.state === 'partially_ready' || rev.state === 'failed' ? rev.state : rev.state === 'compiling' ? 'compiling' : 'queued';
  const jobError = job?.state === 'failed' && job.errorCode && isBuildError(job.errorCode) ? { code: job.errorCode as BuildErrorCode, message: String((job.diagnostics as { error?: { message?: string } } | null)?.error?.message ?? 'The build failed.') } : null;
  let testUrl: string | null = null;
  let testUrlExpiresAt: string | null = null;
  const secret = signingSecret(c);
  if ((state === 'ready' || state === 'partially_ready') && rev.contentHash && secret) {
    const s = await signAssetUrl(await assetSigningKey(secret), appOrigin(c), { id: rev.id, sha256: rev.contentHash }, TEST_LINK_TTL_SECONDS, Date.now(), 'build');
    testUrl = s.url;
    testUrlExpiresAt = s.expiresAt.toISOString();
  }
  const scene = rev.config as { placement?: { mode?: string } };
  return {
    id: rev.id,
    experienceId: rev.experienceId,
    revisionNumber: rev.revisionNumber,
    state,
    placementMode: (scene.placement?.mode ?? 'floor') as BuildSummary['placementMode'],
    outputs,
    error: jobError,
    testUrl,
    testUrlExpiresAt,
    current: currentHash !== null && currentHash === rev.contentHash,
    createdAt: rev.createdAt.toISOString(),
    finishedAt: job?.finishedAt?.toISOString() ?? null,
  };
}

/** Older finished test builds of an experience are removed when a newer one is made (only the latest is kept). */
async function pruneOlderBuilds(c: Context<AppEnv>, db: Database, experienceId: string, keep: string): Promise<void> {
  const old = await db
    .select({ id: experienceRevisions.id })
    .from(experienceRevisions)
    .where(and(eq(experienceRevisions.experienceId, experienceId), isNotNull(experienceRevisions.contentHash), ne(experienceRevisions.id, keep), inArray(experienceRevisions.state, ['ready', 'partially_ready', 'failed'])));
  if (!old.length) return;
  const ids = old.map((o) => o.id);
  const keys = (await db.select({ key: generatedOutputs.r2Key }).from(generatedOutputs).where(inArray(generatedOutputs.revisionId, ids))).flatMap((r) => (r.key ? [r.key] : []));
  await db.delete(experienceRevisions).where(inArray(experienceRevisions.id, ids)); // outputs and jobs cascade
  const store = c.get('assetStore')();
  for (const k of keys) await store.delete(k).catch((e: unknown) => logError(c, 'builds.prune-object', `${k}: ${String(e)}`));
}

export function buildRoutes() {
  const r = new Hono<AppEnv>();

  r.post('/experiences/:id/builds', requireSession, async (c) => {
    const ownerId = c.get('user').id;
    const { db } = await c.get('db')();
    const row = await ownedExperience(db, c.req.param('id'), ownerId);
    if (!row) return notFound(c);
    const draft = DraftExperienceScene.safeParse(row.draft.config);
    if (!draft.success) return err(c, 409, 'conflict', 'The scene is not ready to test yet.', { reason: 'not_ready' });
    const plan = await planBuild(db, ownerId, draft.data);
    if (!plan.ok) return err(c, 409, 'conflict', plan.message, { reason: 'not_ready', issues: plan.issues });

    const [existing] = await db.select().from(experienceRevisions).where(and(eq(experienceRevisions.experienceId, row.e.id), eq(experienceRevisions.contentHash, plan.contentHash))).limit(1);
    if (existing && existing.state !== 'failed') return c.json(await summarize(c, db, existing, plan.contentHash), 200);

    const [{ active } = { active: 0 }] = await db
      .select({ active: sql<number>`count(*)::int` })
      .from(processingJobs)
      .where(and(eq(processingJobs.ownerId, ownerId), eq(processingJobs.type, 'compile_revision'), inArray(processingJobs.state, ['queued', 'running'])));
    if (active >= MAX_ACTIVE_BUILDS) return err(c, 409, 'conflict', 'Wait for your other test builds to finish.', { reason: 'build_running' });

    const input: BuildJobInput = { kind: 'build', contentHash: plan.contentHash, files: plan.files, glbVersion: SCENE_GLB_VERSION, usdzVersion: SCENE_USDZ_VERSION };
    const mode = plan.scene.placement.mode;
    let revisionId: string;
    let jobId: string;
    let attempt = 1;
    if (existing) {
      // An identical build failed before: try it again (bounded attempts, same snapshot).
      const [job] = await db.select().from(processingJobs).where(eq(processingJobs.revisionId, existing.id)).orderBy(desc(processingJobs.createdAt)).limit(1);
      if (!job || job.attempt >= job.maxAttempts) return c.json(await summarize(c, db, existing, plan.contentHash), 200);
      attempt = job.attempt + 1;
      await db.update(generatedOutputs).set({ state: 'pending', validation: null }).where(and(eq(generatedOutputs.revisionId, existing.id), ne(generatedOutputs.state, 'ready')));
      await db.update(experienceRevisions).set({ state: 'compiling' }).where(eq(experienceRevisions.id, existing.id));
      await db.update(processingJobs).set({ state: 'queued', attempt, errorCode: null, finishedAt: null, updatedAt: new Date() }).where(eq(processingJobs.id, job.id));
      revisionId = existing.id;
      jobId = job.id;
    } else {
      const created = await db.transaction(async (tx) => {
        const [{ next } = { next: 1 }] = await tx
          .select({ next: sql<number>`coalesce(max(${experienceRevisions.revisionNumber}), 0)::int + 1` })
          .from(experienceRevisions)
          .where(eq(experienceRevisions.experienceId, row.e.id));
        const [rev] = await tx
          .insert(experienceRevisions)
          .values({ experienceId: row.e.id, revisionNumber: next, state: 'snapshot', schemaVersion: plan.scene.schemaVersion, config: plan.scene, createdBy: ownerId, frozenAt: new Date(), contentHash: plan.contentHash })
          .returning({ id: experienceRevisions.id });
        await tx.insert(generatedOutputs).values([
          { revisionId: rev!.id, runtime: runtimeFor('android', mode), mimeType: MIME_GLB },
          { revisionId: rev!.id, runtime: runtimeFor('ios', mode), mimeType: MIME_USDZ },
        ]);
        const [job] = await tx
          .insert(processingJobs)
          .values({ ownerId, type: 'compile_revision', revisionId: rev!.id, idempotencyKey: `build:${rev!.id}`, attempt: 1, input })
          .returning({ id: processingJobs.id });
        return { revisionId: rev!.id, jobId: job!.id };
      });
      revisionId = created.revisionId;
      jobId = created.jobId;
    }
    await c.get('conversions')().start(jobId, attempt, 'build');
    await pruneOlderBuilds(c, db, row.e.id, revisionId);
    const [rev] = await db.select().from(experienceRevisions).where(eq(experienceRevisions.id, revisionId)).limit(1);
    return c.json(await summarize(c, db, rev!, plan.contentHash), 202);
  });

  r.get('/experiences/:id/builds/latest', requireSession, async (c) => {
    const ownerId = c.get('user').id;
    const { db } = await c.get('db')();
    const row = await ownedExperience(db, c.req.param('id'), ownerId);
    if (!row) return notFound(c);
    const [rev] = await db
      .select()
      .from(experienceRevisions)
      .where(and(eq(experienceRevisions.experienceId, row.e.id), isNotNull(experienceRevisions.contentHash)))
      .orderBy(desc(experienceRevisions.revisionNumber))
      .limit(1);
    if (!rev) return err(c, 404, 'not_found', 'No test build yet.');
    const draft = DraftExperienceScene.safeParse(row.draft.config);
    const plan = draft.success ? await planBuild(db, ownerId, draft.data) : null;
    return c.json(await summarize(c, db, rev, plan?.ok ? plan.contentHash : null));
  });

  // ---------- public: the device test page (no session; the signed link is the credential)
  r.get('/test-builds/:id', async (c) => {
    const id = c.req.param('id');
    const secret = signingSecret(c);
    if (!UUID.test(id) || !secret) return notFound(c);
    const { db } = await c.get('db')();
    const [row] = await db.select({ rev: experienceRevisions, name: experiences.name }).from(experienceRevisions).innerJoin(experiences, eq(experiences.id, experienceRevisions.experienceId)).where(eq(experienceRevisions.id, id)).limit(1);
    if (!row?.rev.contentHash) return notFound(c);
    const key = await assetSigningKey(secret);
    const v = await verifyAssetUrl(key, { id, sha256: row.rev.contentHash }, { v: c.req.query('v'), exp: c.req.query('exp'), sig: c.req.query('sig') }, Date.now(), 'build');
    if (!v.ok) return err(c, 403, 'forbidden', v.reason === 'expired' ? 'This test link has expired. Make a new one in the editor.' : 'This test link is not valid.');
    if (row.rev.state !== 'ready' && row.rev.state !== 'partially_ready') return notFound(c);
    const scene = ExperienceScene.parse(row.rev.config);
    const outs = await db.select().from(generatedOutputs).where(eq(generatedOutputs.revisionId, id));
    const ttl = Math.min(ASSET_LIMITS.readUrlTtlSeconds, v.expiresInSeconds);
    const origin = appOrigin(c);
    const fileUrl = async (platform: 'ios' | 'android') => {
      const o = outs.find((x) => platformOf(x.runtime) === platform);
      return o?.state === 'ready' && o.sha256 ? (await signAssetUrl(key, origin, { id: o.id, sha256: o.sha256 }, ttl, Date.now(), 'output')).url : null;
    };
    const why = (platform: 'ios' | 'android') => {
      const o = outs.find((x) => platformOf(x.runtime) === platform);
      return o?.state === 'failed' ? String((o.validation as { error?: { message?: string } } | null)?.error?.message ?? 'The file could not be made.') : null;
    };
    let tracking: TestBuildResponse['tracking'] = null;
    if (scene.placement.mode === 'image') {
      const [t] = await db.select({ id: assets.id, sha256: assets.sha256 }).from(assets).where(eq(assets.id, scene.placement.trackingTargetAssetId)).limit(1);
      if (t?.sha256) tracking = { widthMeters: scene.placement.physicalWidthMeters, imageUrl: (await signAssetUrl(key, origin, { id: t.id, sha256: t.sha256 }, ttl, Date.now(), 'asset')).url };
    }
    const plan = planInteractions(scene, runtimeFor('android', scene.placement.mode));
    const byId = new Map(scene.actions.map((a) => [a.id, a]));
    const links = pagePlan(scene).map((p) => {
      const a = byId.get(p.actionId)!;
      const href = a.type === 'open-url' ? a.url : a.type === 'mailto' ? `mailto:${a.address}` : a.type === 'tel' ? `tel:${a.number.replace(/[\s()-]/g, '')}` : '';
      return { label: p.label, href, primary: p.primary };
    });
    // Interactions the WebXR image viewer runs (ADR-031): every action with what it does; taps from objects and hotspots.
    const hrefOf = (a: (typeof scene.actions)[number]) => (a.type === 'open-url' ? a.url : a.type === 'mailto' ? `mailto:${a.address}` : a.type === 'tel' ? `tel:${a.number.replace(/[\s()-]/g, '')}` : null);
    const xr: TestBuildResponse['xr'] = {
      actions: scene.actions.map((a) => {
        const label = buttonLabel(a);
        const href = hrefOf(a);
        if (href) return { id: a.id, type: 'link' as const, label, href };
        if (a.type === 'toggle-visibility') return { id: a.id, type: 'toggle-visibility' as const, label, nodeId: a.nodeId };
        return { id: a.id, type: 'play-animation' as const, label, nodeId: (a as { nodeId: string }).nodeId, clip: (a as { clip: string }).clip };
      }),
      taps: Object.fromEntries(scene.nodes.filter((n) => n.actionId).map((n) => [n.id, n.actionId!])),
      hotspots: scene.nodes.filter((n) => n.kind === 'hotspot').map((n) => n.id),
      primaryActionId: plan.primary?.actionId ?? null,
    };
    const body: TestBuildResponse = {
      id,
      name: row.name,
      placementMode: scene.placement.mode,
      tracking,
      glbUrl: await fileUrl('android'),
      usdzUrl: await fileUrl('ios'),
      unavailable: { ios: why('ios'), android: why('android') },
      primary: plan.primary ? { label: plan.primary.label, url: plan.primary.url } : null,
      links,
      xr,
      filesExpireAt: new Date(Date.now() + ttl * 1000).toISOString(),
      linkExpiresAt: new Date(Date.now() + v.expiresInSeconds * 1000).toISOString(),
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  // ---------- public: a compiled file (cookieless; Quick Look and Scene Viewer fetch it themselves)
  r.get('/outputs/:id/content', async (c) => {
    const id = c.req.param('id');
    const secret = signingSecret(c);
    if (!UUID.test(id) || !secret) return notFound(c);
    const { db } = await c.get('db')();
    const [o] = await db.select().from(generatedOutputs).where(eq(generatedOutputs.id, id)).limit(1);
    if (!o || o.state !== 'ready' || !o.sha256 || !o.r2Key) return notFound(c);
    const v = await verifyAssetUrl(await assetSigningKey(secret), { id: o.id, sha256: o.sha256 }, { v: c.req.query('v'), exp: c.req.query('exp'), sig: c.req.query('sig') }, Date.now(), 'output');
    if (!v.ok) return err(c, 403, 'forbidden', v.reason === 'expired' ? 'This link has expired.' : 'This link is not valid.');
    const obj = await c.get('assetStore')().get(o.r2Key);
    if (!obj) {
      logError(c, 'outputs.object-missing', o.id);
      return notFound(c);
    }
    const glb = platformOf(o.runtime) === 'android';
    return new Response(obj.body, {
      headers: {
        'content-type': glb ? MIME_GLB : MIME_USDZ,
        'content-length': String(obj.size),
        etag: `"${o.sha256}"`,
        'cache-control': `private, max-age=${Math.min(v.expiresInSeconds, ASSET_LIMITS.readUrlTtlSeconds)}`,
        'content-disposition': `inline; filename="experience.${glb ? 'glb' : 'usdz'}"`,
      },
    });
  });

  return r;
}

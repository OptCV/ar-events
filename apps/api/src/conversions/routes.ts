/**
 * Image-to-AR conversions (Phase 2 Milestone 1, ADR-023).
 *   POST /api/assets/:id/image-objects    start (or reuse) a conversion of a validated display image
 *   GET  /api/assets/:id/image-objects    conversions of one image, newest first
 *   GET  /api/image-objects               finished GLB + USDZ pairs that can be placed in experiences (M7)
 *   GET  /api/conversions/:id             one conversion with its outputs (signed read URLs when ready)
 *   GET  /api/derivatives/:id/content     signed, cookieless read of a generated GLB/USDZ
 * Ownership is enforced in SQL; another user's asset or conversion is a 404.
 */
import { Hono, type Context } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  ASSET_LIMITS,
  ConversionListResponse,
  ConversionSummary,
  CreateImageObjectInput,
  ImageObjectListResponse,
  MAX_ACTIVE_CONVERSIONS,
  USD_CONVERTER_VERSION,
  formatBytes,
  type DerivativeOutput,
  type ImageObjectSummary,
} from '@ar-creator/contracts';
import { schema, type Database } from '@ar-creator/db';
import type { AppEnv } from '../app.ts';
import { requireSession } from '../auth/middleware.ts';
import { logError } from '../db.ts';
import { UUID, err, parseJson } from '../http.ts';
import { assetSigningKey, signAssetUrl, verifyAssetUrl } from '../assets/signing.ts';
import { derivativeBytes } from '../assets/usage.ts';
import { GLB_CONVERTER_VERSION, MIME_GLB, MIME_USDZ, failJob, imageObjectJobKey, settingsHash, type ImageObjectJobInput } from './pipeline.ts';

const { assets, assetDerivatives, processingJobs } = schema;
type JobRow = typeof processingJobs.$inferSelect;
type DerivativeRow = typeof assetDerivatives.$inferSelect;

const CONVERTIBLE_TYPES = ['image/png', 'image/jpeg'];

const signingSecret = (c: Context<AppEnv>) => {
  const s = c.get('authConfig').secret;
  return s && s.length >= 32 ? s : null;
};
const appOrigin = (c: Context<AppEnv>) => c.get('authConfig').baseURL ?? new URL(c.req.url).origin;

function downloadName(filename: string | null, ext: 'glb' | 'usdz'): string {
  const stem = (filename ?? 'image').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  return `${stem}-image-object.${ext}`;
}

async function outputOf(c: Context<AppEnv>, d: DerivativeRow | undefined, format: 'glb' | 'usdz', filename: string | null): Promise<DerivativeOutput | null> {
  if (!d) return null;
  let contentUrl: string | null = null;
  let contentUrlExpiresAt: string | null = null;
  const secret = signingSecret(c);
  if (d.status === 'ready' && d.sha256 && secret) {
    const s = await signAssetUrl(await assetSigningKey(secret), appOrigin(c), { id: d.id, sha256: d.sha256 }, ASSET_LIMITS.readUrlTtlSeconds, Date.now(), 'derivative');
    contentUrl = s.url;
    contentUrlExpiresAt = s.expiresAt.toISOString();
  }
  return { id: d.id, format, state: d.status, sizeBytes: d.sizeBytes, sha256: d.sha256, converterVersion: d.converterVersion, contentUrl, contentUrlExpiresAt, downloadName: downloadName(filename, format) };
}

async function summarize(c: Context<AppEnv>, db: Database, job: JobRow, filename: string | null): Promise<ConversionSummary> {
  const input = job.input as ImageObjectJobInput;
  const outs = await db
    .select()
    .from(assetDerivatives)
    .where(
      and(
        eq(assetDerivatives.sourceAssetId, job.assetId!),
        eq(assetDerivatives.settingsHash, input.settingsHash),
        inArray(assetDerivatives.converterVersion, [input.glbConverterVersion, input.usdConverterVersion]),
      ),
    );
  const glb = outs.find((d) => d.outputType === 'image_object_glb' && d.converterVersion === input.glbConverterVersion);
  const usdz = outs.find((d) => d.outputType === 'image_object_usdz' && d.converterVersion === input.usdConverterVersion);
  const diag = (job.diagnostics ?? {}) as { alphaMode?: string; widthMeters?: number; heightMeters?: number; alpha?: unknown; error?: { code: string; message: string } };
  const glbDiag = (glb?.diagnostics ?? {}) as typeof diag;
  const known = { ...glbDiag, ...diag };
  return ConversionSummary.parse({
    id: job.id,
    sourceAssetId: job.assetId,
    state: job.state === 'cancelled' ? 'failed' : job.state,
    settings: input.settings,
    resolvedAlphaMode: known.alphaMode ?? null,
    widthMeters: known.widthMeters ?? null,
    heightMeters: known.heightMeters ?? null,
    alpha: known.alpha ?? null,
    outputs: {
      // Outputs are only offered once both exist: a half-finished pair is never presented as a result.
      glb: await outputOf(c, glb, 'glb', filename),
      usdz: await outputOf(c, usdz, 'usdz', filename),
    },
    error: job.state === 'failed' ? { code: job.errorCode ?? 'internal', message: diag.error?.message ?? 'The conversion failed.' } : null,
    attempt: job.attempt,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  });
}

export function conversionRoutes() {
  const r = new Hono<AppEnv>();

  async function ownedAsset(c: Context<AppEnv>, id: string) {
    if (!UUID.test(id)) return null;
    const { db } = await c.get('db')();
    const [a] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.ownerId, c.get('user').id)))
      .limit(1);
    return a && a.state !== 'deleted' ? a : null;
  }

  // ---------- start or reuse a conversion
  r.post('/assets/:id/image-objects', requireSession, async (c) => {
    const a = await ownedAsset(c, c.req.param('id'));
    if (!a) return err(c, 404, 'not_found', 'Asset not found.');
    if (a.state !== 'validated') return err(c, 409, 'conflict', 'This file has not finished uploading.', { reason: 'not_convertible' });
    if (a.role !== 'display-image') {
      return err(c, 409, 'conflict', 'Only display images can become AR objects. Upload the picture again as a display image.', { reason: 'not_convertible' });
    }
    if (!a.mimeType || !CONVERTIBLE_TYPES.includes(a.mimeType)) return err(c, 409, 'conflict', 'Only PNG and JPEG images can be converted.', { reason: 'not_convertible' });
    const p = await parseJson(c, CreateImageObjectInput);
    if (!p.ok) return p.res;
    const settings = p.data.settings;
    const ownerId = c.get('user').id;
    const hash = await settingsHash(settings);
    const key = imageObjectJobKey(a.id, hash);
    const input: ImageObjectJobInput = { kind: 'image-object', settings, settingsHash: hash, glbConverterVersion: GLB_CONVERTER_VERSION, usdConverterVersion: USD_CONVERTER_VERSION };
    const { db } = await c.get('db')();

    const outcome = await db.transaction(async (tx) => {
      // Serialise this user's job creation so the active-job cap cannot be raced.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`conversions:${ownerId}`}, 0))`);
      const [existing] = await tx.select().from(processingJobs).where(eq(processingJobs.idempotencyKey, key)).limit(1);
      if (existing && existing.ownerId !== ownerId) throw new Error('idempotency key owned by another user'); // unreachable: key embeds the owned asset id
      if (existing && existing.state !== 'failed') return { kind: 'existing' as const, job: existing };
      if (existing && existing.attempt >= existing.maxAttempts) return { kind: 'exhausted' as const, job: existing };
      const [active] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(processingJobs)
        .where(and(eq(processingJobs.ownerId, ownerId), inArray(processingJobs.state, ['queued', 'running'])));
      if ((active?.n ?? 0) >= MAX_ACTIVE_CONVERSIONS) return { kind: 'busy' as const };
      // Outputs are about twice the source size; refuse up front instead of failing after the work is done.
      const [used] = await tx
        .select({ bytes: sql<number>`coalesce(sum(${assets.sizeBytes}), 0)::bigint` })
        .from(assets)
        .where(and(eq(assets.ownerId, ownerId), inArray(assets.state, ['uploaded', 'validated'])));
      if (Number(used?.bytes ?? 0) + (await derivativeBytes(tx, ownerId)) + 2 * (a.sizeBytes ?? 0) > ASSET_LIMITS.quotaBytes) return { kind: 'quota' as const };
      if (existing) {
        const [job] = await tx
          .update(processingJobs)
          .set({ state: 'queued', attempt: existing.attempt + 1, errorCode: null, startedAt: null, finishedAt: null, diagnostics: null, updatedAt: new Date() })
          .where(and(eq(processingJobs.id, existing.id), eq(processingJobs.state, 'failed')))
          .returning();
        return { kind: 'started' as const, job: job! };
      }
      const [job] = await tx.insert(processingJobs).values({ ownerId, type: 'convert_image_to_ar', state: 'queued', idempotencyKey: key, assetId: a.id, attempt: 1, input }).returning();
      return { kind: 'started' as const, job: job! };
    });

    if (outcome.kind === 'busy') return err(c, 429, 'too_many_requests', `You can run ${MAX_ACTIVE_CONVERSIONS} conversions at a time. Wait for one to finish.`);
    if (outcome.kind === 'quota') {
      return err(c, 409, 'conflict', `Converting this image would exceed your ${formatBytes(ASSET_LIMITS.quotaBytes)} storage limit. Delete unused assets first.`, { reason: 'quota_exceeded' });
    }
    if (outcome.kind === 'existing' || outcome.kind === 'exhausted') return c.json(await summarize(c, db, outcome.job, a.originalFilename), 200);

    try {
      await c.get('conversions')().start(outcome.job.id, outcome.job.attempt);
    } catch (e) {
      logError(c, 'conversions.start', String((e as Error).message ?? e));
      await failJob({ db }, outcome.job.id, 'internal', 'The conversion could not be started. Try again.');
      return err(c, 503, 'unavailable', 'Conversions are not available right now. Try again in a moment.');
    }
    return c.json(await summarize(c, db, outcome.job, a.originalFilename), 202);
  });

  r.get('/assets/:id/image-objects', requireSession, async (c) => {
    const a = await ownedAsset(c, c.req.param('id'));
    if (!a) return err(c, 404, 'not_found', 'Asset not found.');
    const { db } = await c.get('db')();
    const jobs = await db
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.ownerId, c.get('user').id), eq(processingJobs.assetId, a.id), eq(processingJobs.type, 'convert_image_to_ar')))
      .orderBy(desc(processingJobs.updatedAt))
      .limit(20);
    return c.json(ConversionListResponse.parse({ conversions: await Promise.all(jobs.map((j) => summarize(c, db, j, a.originalFilename))) }));
  });

  /** Finished image objects (GLB + USDZ both ready) the owner can place in experiences, newest first. */
  r.get('/image-objects', requireSession, async (c) => {
    const { db } = await c.get('db')();
    const rows = await db
      .select({ job: processingJobs, asset: assets })
      .from(processingJobs)
      .innerJoin(assets, eq(assets.id, processingJobs.assetId))
      .where(and(eq(processingJobs.ownerId, c.get('user').id), eq(processingJobs.type, 'convert_image_to_ar'), eq(processingJobs.state, 'succeeded'), eq(assets.state, 'validated')))
      .orderBy(desc(processingJobs.finishedAt))
      .limit(100);
    const secret = signingSecret(c);
    const key = secret ? await assetSigningKey(secret) : null;
    const out: ImageObjectSummary[] = [];
    for (const { job, asset } of rows) {
      const s = await summarize(c, db, job, asset.originalFilename);
      if (!s.outputs.glb?.contentUrl || !s.outputs.usdz?.contentUrl) continue; // only complete pairs
      const preview = key && asset.sha256 ? await signAssetUrl(key, appOrigin(c), { id: asset.id, sha256: asset.sha256 }, ASSET_LIMITS.readUrlTtlSeconds) : null;
      out.push({
        id: s.outputs.glb.id,
        conversionId: s.id,
        sourceAssetId: asset.id,
        sourceFilename: asset.originalFilename,
        previewUrl: preview?.url ?? null,
        settings: s.settings,
        resolvedAlphaMode: s.resolvedAlphaMode,
        widthMeters: s.widthMeters,
        heightMeters: s.heightMeters,
        glb: s.outputs.glb,
        usdz: s.outputs.usdz,
        createdAt: s.finishedAt ?? s.createdAt,
      });
    }
    return c.json(ImageObjectListResponse.parse({ imageObjects: out }));
  });

  r.get('/conversions/:id', requireSession, async (c) => {
    const id = c.req.param('id');
    const notFound = () => err(c, 404, 'not_found', 'Conversion not found.');
    if (!UUID.test(id)) return notFound();
    const { db } = await c.get('db')();
    const [row] = await db
      .select({ job: processingJobs, filename: assets.originalFilename })
      .from(processingJobs)
      .innerJoin(assets, eq(assets.id, processingJobs.assetId))
      .where(and(eq(processingJobs.id, id), eq(processingJobs.ownerId, c.get('user').id), eq(processingJobs.type, 'convert_image_to_ar')))
      .limit(1);
    return row ? c.json(await summarize(c, db, row.job, row.filename)) : notFound();
  });

  // ---------- signed read of a generated output (no session: native viewers send no cookies)
  r.get('/derivatives/:id/content', async (c) => {
    const id = c.req.param('id');
    const notFound = () => err(c, 404, 'not_found', 'File not found.');
    if (!UUID.test(id)) return notFound();
    const secret = signingSecret(c);
    if (!secret) return err(c, 503, 'unavailable', 'File delivery is not configured.');
    const { db } = await c.get('db')();
    const [d] = await db
      .select({ id: assetDerivatives.id, sha256: assetDerivatives.sha256, r2Key: assetDerivatives.r2Key, outputType: assetDerivatives.outputType, filename: assets.originalFilename })
      .from(assetDerivatives)
      .innerJoin(assets, eq(assets.id, assetDerivatives.sourceAssetId))
      .where(and(eq(assetDerivatives.id, id), eq(assetDerivatives.status, 'ready'), eq(assets.state, 'validated')))
      .limit(1);
    if (!d?.sha256 || !d.r2Key || d.outputType === 'thumbnail') return notFound();
    const v = await verifyAssetUrl(await assetSigningKey(secret), { id: d.id, sha256: d.sha256 }, { v: c.req.query('v'), exp: c.req.query('exp'), sig: c.req.query('sig') }, Date.now(), 'derivative');
    if (!v.ok) return err(c, 403, 'forbidden', v.reason === 'expired' ? 'This link has expired.' : 'This link is not valid.');
    const obj = await c.get('assetStore')().get(d.r2Key);
    if (!obj) {
      logError(c, 'derivatives.object-missing', d.id);
      return notFound();
    }
    const format = d.outputType === 'image_object_glb' ? 'glb' : 'usdz';
    const disposition = c.req.query('download') === '1' ? 'attachment' : 'inline';
    return new Response(obj.body, {
      headers: {
        // Quick Look and Scene Viewer rely on these exact types.
        'content-type': format === 'glb' ? MIME_GLB : MIME_USDZ,
        'content-length': String(obj.size),
        etag: `"${d.sha256}"`,
        'cache-control': `private, max-age=${Math.min(v.expiresInSeconds, ASSET_LIMITS.readUrlTtlSeconds)}`,
        'content-disposition': `${disposition}; filename="${downloadName(d.filename, format)}"`,
      },
    });
  });

  return r;
}

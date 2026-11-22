import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  ASSET_LIMITS,
  AssetListResponse,
  AssetSummary,
  CreateUploadInput,
  CreateUploadResponse,
  UploadableRole,
  formatBytes,
  type FileRejection,
} from '@ar-creator/contracts';
import { schema } from '@ar-creator/db';
import type { AppEnv } from '../app.ts';
import { requireSession } from '../auth/middleware.ts';
import { logError } from '../db.ts';
import { UUID, err, parseJson } from '../http.ts';
import { UploadRejected, createUploadPipeline } from './pipeline.ts';
import { assetSigningKey, signAssetUrl, verifyAssetUrl } from './signing.ts';
import { derivativeBytes } from './usage.ts';

const { assets, assetDerivatives, experiences, experienceRevisions, processingJobs } = schema;
type AssetRow = typeof assets.$inferSelect;

export class StorageUnavailableError extends Error {
  override name = 'StorageUnavailableError';
}

/** Generated key layout (DATA_MODEL.md); never derived from user input other than the server-side user id. */
export function originalKey(ownerId: string, assetId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId) || !UUID.test(assetId)) throw new Error('unsafe storage key component');
  return `users/${ownerId}/assets/${assetId}/original`;
}

/**
 * Display name only: strips any path, control and bidirectional-override characters (which can disguise
 * extensions, e.g. "gpj.exe"), normalises Unicode and bounds the length. Never used for storage.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .trim()
    .slice(0, 255);
  return clean || 'upload';
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'model/gltf-binary': 'glb' };

const notFound = (c: Context<AppEnv>) => err(c, 404, 'not_found', 'Asset not found.');

function signingSecret(c: Context<AppEnv>): string | null {
  const s = c.get('authConfig').secret;
  return s && s.length >= 32 ? s : null;
}

function appOrigin(c: Context<AppEnv>): string {
  return c.get('authConfig').baseURL ?? new URL(c.req.url).origin;
}

async function summarize(c: Context<AppEnv>, a: AssetRow): Promise<AssetSummary> {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  let contentUrl: string | null = null;
  let contentUrlExpiresAt: string | null = null;
  const secret = signingSecret(c);
  if (a.state === 'validated' && a.sha256 && secret) {
    const s = await signAssetUrl(await assetSigningKey(secret), appOrigin(c), { id: a.id, sha256: a.sha256 }, ASSET_LIMITS.readUrlTtlSeconds);
    contentUrl = s.url;
    contentUrlExpiresAt = s.expiresAt.toISOString();
  }
  const validated = a.state === 'validated';
  return AssetSummary.parse({
    id: a.id,
    role: a.role,
    state: a.state,
    filename: a.originalFilename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    sha256: a.sha256,
    ...(validated && meta.image ? { image: meta.image } : {}),
    ...(validated && meta.model ? { model: meta.model } : {}),
    warnings: Array.isArray(meta.warnings) ? meta.warnings : [],
    rejectionCode: a.rejectionCode,
    createdAt: a.createdAt.toISOString(),
    contentUrl,
    contentUrlExpiresAt,
  });
}

/**
 * Asset storage (Milestone 5, ADR-022).
 *   POST   /api/assets/uploads      reserve an upload slot (pending asset + upload target)
 *   PUT    /api/assets/:id/content  stream the bytes (worker-stream strategy); validated before commit
 *   GET    /api/assets              list validated assets (+ signed read URLs, usage)
 *   GET    /api/assets/:id          one asset (any state except deleted)
 *   DELETE /api/assets/:id          delete (refused while any revision references it)
 *   GET    /api/assets/:id/content  signed, cookieless private read
 * Ownership is enforced in SQL on every session route; another user's asset is a 404.
 */
export function assetRoutes() {
  const r = new Hono<AppEnv>();
  const jsonLimit = bodyLimit({ maxSize: 16 * 1024, onError: (c) => err(c, 413, 'payload_too_large', 'The request is too large.') });

  async function owned(c: Context<AppEnv>, id: string): Promise<AssetRow | null> {
    if (!UUID.test(id)) return null;
    const { db } = await c.get('db')();
    const [row] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.ownerId, c.get('user').id)))
      .limit(1);
    return row ?? null;
  }

  // ---------- signed read (no session: native viewers send no cookies)
  r.get('/:id/content', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return notFound(c);
    const secret = signingSecret(c);
    if (!secret) return err(c, 503, 'unavailable', 'Asset delivery is not configured.');
    const { db } = await c.get('db')();
    const [a] = await db
      .select({ id: assets.id, sha256: assets.sha256, mimeType: assets.mimeType, r2Key: assets.r2Key, sizeBytes: assets.sizeBytes })
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.state, 'validated')))
      .limit(1);
    if (!a?.sha256 || !a.mimeType) return notFound(c);
    const v = await verifyAssetUrl(await assetSigningKey(secret), { id: a.id, sha256: a.sha256 }, { v: c.req.query('v'), exp: c.req.query('exp'), sig: c.req.query('sig') });
    if (!v.ok) return err(c, 403, 'forbidden', v.reason === 'expired' ? 'This link has expired.' : 'This link is not valid.');
    const obj = await c.get('assetStore')().get(a.r2Key);
    if (!obj) {
      logError(c, 'assets.object-missing', a.id);
      return notFound(c);
    }
    return new Response(obj.body, {
      headers: {
        'content-type': a.mimeType,
        'content-length': String(obj.size),
        etag: `"${a.sha256}"`,
        // Private: never cached by shared caches; browser may reuse it until the link expires.
        'cache-control': `private, max-age=${Math.min(v.expiresInSeconds, ASSET_LIMITS.readUrlTtlSeconds)}`,
        'content-disposition': `inline; filename="asset.${EXT[a.mimeType] ?? 'bin'}"`,
      },
    });
  });

  // ---------- reserve an upload slot
  r.post('/uploads', requireSession, jsonLimit, async (c) => {
    const p = await parseJson(c, CreateUploadInput);
    if (!p.ok) return p.res;
    const { role, filename, contentType, sizeBytes, sha256 } = p.data;
    const ownerId = c.get('user').id;
    const { db } = await c.get('db')();
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ASSET_LIMITS.uploadTtlSeconds * 1000);

    const outcome = await db.transaction(async (tx) => {
      // Serialise this user's reservations so the pending-slot and quota checks cannot be raced.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`assets:${ownerId}`}, 0))`);
      const live = and(eq(assets.state, 'pending_upload'), isNull(assets.uploadClaimedAt), gt(assets.uploadExpiresAt, sql`now()`));
      const [pending] = await tx.select({ n: sql<number>`count(*)::int` }).from(assets).where(and(eq(assets.ownerId, ownerId), live));
      if ((pending?.n ?? 0) >= ASSET_LIMITS.maxPendingUploads) return 'too_many' as const;
      const [used] = await tx
        .select({ bytes: sql<number>`coalesce(sum(${assets.sizeBytes}), 0)::bigint` })
        .from(assets)
        .where(and(eq(assets.ownerId, ownerId), or(inArray(assets.state, ['uploaded', 'validated']), live)));
      if (Number(used?.bytes ?? 0) + (await derivativeBytes(tx, ownerId)) + sizeBytes > ASSET_LIMITS.quotaBytes) return 'quota' as const;
      const [row] = await tx
        .insert(assets)
        .values({
          id,
          ownerId,
          role,
          state: 'pending_upload',
          mimeType: contentType,
          sizeBytes,
          r2Key: originalKey(ownerId, id),
          originalFilename: sanitizeFilename(filename),
          metadata: sha256 ? { declaredSha256: sha256 } : {},
          uploadExpiresAt: expiresAt,
        })
        .returning();
      return row!;
    });
    if (outcome === 'too_many') return err(c, 429, 'too_many_requests', 'Too many uploads are in progress. Wait for them to finish and try again.');
    if (outcome === 'quota') {
      return err(c, 409, 'conflict', `This upload would exceed your ${formatBytes(ASSET_LIMITS.quotaBytes)} storage limit. Delete unused assets first.`, { reason: 'quota_exceeded' });
    }
    const body = CreateUploadResponse.parse({
      asset: await summarize(c, outcome),
      upload: { strategy: 'worker-stream', method: 'PUT', url: `/api/assets/${id}/content`, headers: { 'content-type': contentType }, expiresAt: expiresAt.toISOString(), maxBytes: sizeBytes },
    });
    return c.json(body, 201);
  });

  // ---------- receive the bytes (one attempt per slot)
  r.put('/:id/content', requireSession, async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return notFound(c);
    const ownerId = c.get('user').id;
    const { db } = await c.get('db')();
    const store = c.get('assetStore')(); // fail with 503 before consuming the slot if storage is not configured
    const [slot] = await db
      .update(assets)
      .set({ uploadClaimedAt: sql`now()` })
      .where(and(eq(assets.id, id), eq(assets.ownerId, ownerId), eq(assets.state, 'pending_upload'), isNull(assets.uploadClaimedAt), gt(assets.uploadExpiresAt, sql`now()`)))
      .returning();
    if (!slot) {
      if (!(await owned(c, id))) return notFound(c);
      return err(c, 409, 'conflict', 'This upload has already been used or has expired. Start the upload again.', { reason: 'upload_not_pending' });
    }
    const role = UploadableRole.parse(slot.role);
    const declaredSize = slot.sizeBytes!;
    const declaredType = slot.mimeType!;
    const declaredSha = (slot.metadata as { declaredSha256?: string }).declaredSha256;

    const markRejected = (code: FileRejection) =>
      db
        .update(assets)
        .set({ state: 'rejected', rejectionCode: code })
        .where(and(eq(assets.id, id), eq(assets.state, 'pending_upload')));
    const reject = async (code: FileRejection, message: string) => {
      await markRejected(code);
      return err(c, 422, 'invalid_file', message, { reason: code });
    };

    const length = c.req.header('content-length');
    if (length === undefined) {
      await markRejected('size_mismatch');
      return err(c, 411, 'bad_request', 'The upload must include a Content-Length header.');
    }
    if (!/^\d+$/.test(length) || Number(length) !== declaredSize) return reject('size_mismatch', `The file size does not match the declared ${formatBytes(declaredSize)}.`);
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== declaredType) return reject('type_mismatch', 'The upload type does not match the declared file type.');
    const body = c.req.raw.body;
    if (!body) return reject('incomplete', 'The upload had no content.');

    const pipeline = createUploadPipeline({ role, declaredType, size: declaredSize, expectedSha256: declaredSha });
    try {
      await store.put(slot.r2Key, body.pipeThrough(pipeline.transform), { size: declaredSize, contentType: declaredType, ...(declaredSha ? { sha256Hex: declaredSha } : {}) });
    } catch (e) {
      if (e instanceof UploadRejected) return reject(e.code, e.message);
      logError(c, 'assets.upload-failed', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown');
      await markRejected('incomplete');
      return err(c, 503, 'unavailable', 'The upload could not be stored. Please try again.');
    }

    const result = pipeline.outcome();
    const [done] = await db
      .update(assets)
      .set({
        state: 'validated',
        sha256: result.sha256,
        sizeBytes: result.size,
        mimeType: result.inspection.mime,
        metadata: { [result.inspection.mime === 'model/gltf-binary' ? 'model' : 'image']: result.inspection.metadata, warnings: result.inspection.warnings },
      })
      .where(and(eq(assets.id, id), eq(assets.ownerId, ownerId), eq(assets.state, 'pending_upload')))
      .returning();
    if (!done) {
      // Deleted while uploading: do not leave an orphaned object behind.
      await store.delete(slot.r2Key);
      return err(c, 409, 'conflict', 'This upload was cancelled.', { reason: 'upload_not_pending' });
    }
    return c.json(await summarize(c, done));
  });

  // ---------- read / list
  r.get('/', requireSession, async (c) => {
    const roleQ = c.req.query('role');
    const role = roleQ === undefined ? undefined : UploadableRole.safeParse(roleQ);
    if (role && !role.success) return err(c, 400, 'bad_request', 'Unknown asset role.');
    const ownerId = c.get('user').id;
    const { db } = await c.get('db')();
    const rows = await db
      .select()
      .from(assets)
      .where(and(eq(assets.ownerId, ownerId), eq(assets.state, 'validated'), role?.success ? eq(assets.role, role.data) : undefined))
      .orderBy(desc(assets.createdAt))
      .limit(200);
    const [used] = await db
      .select({ bytes: sql<number>`coalesce(sum(${assets.sizeBytes}), 0)::bigint` })
      .from(assets)
      .where(and(eq(assets.ownerId, ownerId), inArray(assets.state, ['uploaded', 'validated'])));
    return c.json(
      AssetListResponse.parse({
        assets: await Promise.all(rows.map((a) => summarize(c, a))),
        usage: { bytes: Number(used?.bytes ?? 0) + (await derivativeBytes(db, ownerId)), quotaBytes: ASSET_LIMITS.quotaBytes },
      }),
    );
  });

  r.get('/:id', requireSession, async (c) => {
    const a = await owned(c, c.req.param('id'));
    return a && a.state !== 'deleted' ? c.json(await summarize(c, a)) : notFound(c);
  });

  // ---------- delete
  r.delete('/:id', requireSession, async (c) => {
    const id = c.req.param('id');
    const a = await owned(c, id);
    if (!a) return notFound(c);
    const ownerId = c.get('user').id;
    const { db } = await c.get('db')();
    // Any revision (draft or frozen) of this user's experiences that references the asset, or an image object
    // generated from it (scene `image-object` nodes reference its derivatives, ADR-023), blocks deletion.
    const derivedIds = (await db.select({ id: assetDerivatives.id }).from(assetDerivatives).where(eq(assetDerivatives.sourceAssetId, id))).map((d) => d.id);
    const usesDerivative = derivedIds.length
      ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${experienceRevisions.config} -> 'nodes') AS n WHERE n ->> 'derivativeId' IN (${sql.join(
          derivedIds.map((d) => sql`${d}`),
          sql`, `,
        )}))`
      : sql`false`;
    const users = await db
      .selectDistinct({ name: experiences.name })
      .from(experienceRevisions)
      .innerJoin(experiences, eq(experiences.id, experienceRevisions.experienceId))
      .where(
        and(
          eq(experiences.ownerId, ownerId),
          or(
            sql`${experienceRevisions.config} -> 'placement' ->> 'trackingTargetAssetId' = ${id}`,
            sql`${experienceRevisions.config} -> 'nodes' @> ${JSON.stringify([{ assetId: id }])}::jsonb`,
            usesDerivative,
          ),
        ),
      )
      .limit(4);
    if (users.length) {
      const names = users.slice(0, 3).map((u) => `“${u.name}”`).join(', ');
      return err(c, 409, 'conflict', `This asset is used by ${names}${users.length > 3 ? ' and others' : ''}. Remove it there first.`, { reason: 'asset_in_use' });
    }
    // A running conversion would write outputs for a source that is going away (ADR-023).
    const [active] = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(and(eq(processingJobs.assetId, id), eq(processingJobs.ownerId, ownerId), inArray(processingJobs.state, ['queued', 'running'])))
      .limit(1);
    if (active) return err(c, 409, 'conflict', 'This image is being converted. Wait for the conversion to finish, then delete it.', { reason: 'conversion_running' });
    // Hide first, then remove the objects (generated outputs, then the original), then the row: a storage failure
    // leaves a hidden row to retry, never a visible asset whose bytes are gone, and never an orphaned private
    // object without a row pointing at it. Derivative rows cascade with the asset row.
    await db.update(assets).set({ state: 'deleted' }).where(and(eq(assets.id, id), eq(assets.ownerId, ownerId)));
    const store = c.get('assetStore')();
    const outputs = await db.select({ key: assetDerivatives.r2Key }).from(assetDerivatives).where(eq(assetDerivatives.sourceAssetId, id));
    for (const o of outputs) if (o.key) await store.delete(o.key);
    await store.delete(a.r2Key);
    await db.delete(assets).where(and(eq(assets.id, id), eq(assets.ownerId, ownerId)));
    return c.body(null, 204);
  });

  return r;
}


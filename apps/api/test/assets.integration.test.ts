/**
 * Milestone 5 — asset storage API against local Docker Postgres + an in-memory object store (fresh DB per file).
 * The R2 adapter is exercised in workerd separately (assets.workerd.test.ts) and end-to-end in Playwright.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, AssetListResponse, AssetSummary, CreateUploadResponse, ExperienceDetail, ReadinessResponse, type UploadableRole } from '@ar-creator/contracts';
import { createTempDatabase, migrateDatabase } from '../../../packages/db/test/helpers.ts';
import { hugePng, makeGlb, photoJpeg, sha256Hex, trackingPng } from './files.ts';
import { Jar, PASSWORD, linkIn, makeHarness, uniqueEmail, type Harness } from './harness.ts';
import { connectDb } from '@ar-creator/db';
import { SWEEP, sweep } from '../src/maintenance.ts';

let temp: Awaited<ReturnType<typeof createTempDatabase>>;
let h: Harness;
let alice: Jar;
let bob: Jar;

async function signedIn(): Promise<Jar> {
  const email = uniqueEmail();
  const before = h.mails.length;
  await h.req('/api/auth/sign-up/email', { body: { name: 'Creator', email, password: PASSWORD, callbackURL: '/email-verified' } });
  await h.req(linkIn(h.mails.slice(before).find((m) => m.to === email)).replace(/^https?:\/\/[^/]+/, ''));
  const jar = new Jar();
  expect((await h.req('/api/auth/sign-in/email', { body: { email, password: PASSWORD }, jar })).status).toBe(200);
  return jar;
}

const TYPE = { png: 'image/png', jpeg: 'image/jpeg', glb: 'model/gltf-binary' } as const;

async function reserve(jar: Jar, role: UploadableRole, bytes: Uint8Array, type: string, extra: Record<string, unknown> = {}) {
  const r = await h.req('/api/assets/uploads', { body: { role, filename: 'file', contentType: type, sizeBytes: bytes.length, ...extra }, jar });
  return { r, slot: r.status === 201 ? CreateUploadResponse.parse(await r.json()) : null };
}

const put = (jar: Jar, url: string, bytes: Uint8Array, type: string, length?: string | null) =>
  h.req(url, { method: 'PUT', raw: { bytes, type, ...(length !== undefined ? { length } : {}) }, jar });

async function upload(jar: Jar, role: UploadableRole, bytes: Uint8Array, type: string, extra: Record<string, unknown> = {}) {
  const { slot } = await reserve(jar, role, bytes, type, extra);
  const r = await put(jar, slot!.upload.url, bytes, type);
  expect(r.status, await r.clone().text()).toBe(200);
  return AssetSummary.parse(await r.json());
}

const errorOf = async (r: Response) => ApiError.parse(await r.json()).error;
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

beforeAll(async () => {
  temp = await createTempDatabase();
  await migrateDatabase(temp.url);
  h = makeHarness({ dbUrl: temp.url });
  alice = await signedIn();
  bob = await signedIn();
});
afterAll(async () => temp?.drop());

describe('authentication and CSRF', () => {
  it('every session route requires a session (401)', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, path, body] of [
      ['GET', '/api/assets', undefined],
      ['POST', '/api/assets/uploads', { role: 'model', filename: 'a', contentType: TYPE.glb, sizeBytes: 10 }],
      ['GET', `/api/assets/${id}`, undefined],
      ['DELETE', `/api/assets/${id}`, undefined],
    ] as const) {
      expect((await h.req(path, { method, ...(body ? { body } : {}) })).status, `${method} ${path}`).toBe(401);
    }
    expect((await put(new Jar(), `/api/assets/${id}/content`, trackingPng(), TYPE.png)).status).toBe(401);
  });

  it('cross-origin reservations and uploads are refused (403); only the upload route accepts a non-JSON body', async () => {
    const png = trackingPng();
    const cross = await h.req('/api/assets/uploads', { body: { role: 'display-image', filename: 'a.png', contentType: TYPE.png, sizeBytes: png.length }, jar: alice, origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    const { slot } = await reserve(alice, 'display-image', png, TYPE.png);
    expect((await h.req(slot!.upload.url, { method: 'PUT', raw: { bytes: png, type: TYPE.png }, jar: alice, origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.req(slot!.upload.url, { method: 'PUT', raw: { bytes: png, type: TYPE.png }, jar: alice, origin: null })).status).toBe(403);
    // Non-JSON bodies stay forbidden everywhere else.
    expect((await h.req('/api/assets/uploads', { method: 'POST', raw: { bytes: png, type: TYPE.png }, jar: alice })).status).toBe(403);
    // The refused attempts did not consume the slot.
    expect((await put(alice, slot!.upload.url, png, TYPE.png)).status).toBe(200);
  });
});

describe('upload, validate, store, read', () => {
  it('stores a checked tracking image under a generated key and serves it via a signed URL without cookies', async () => {
    const png = trackingPng();
    const sha = await sha256Hex(png);
    const { r, slot } = await reserve(alice, 'tracking-image', png, TYPE.png, { filename: 'C:\\fakepath\\poster\u202Egnp.png', sha256: sha });
    expect(r.status).toBe(201);
    expect(slot!.asset).toMatchObject({ state: 'pending_upload', role: 'tracking-image', filename: 'postergnp.png', contentUrl: null });
    expect(slot!.upload).toMatchObject({ strategy: 'worker-stream', method: 'PUT', url: `/api/assets/${slot!.asset.id}/content`, headers: { 'content-type': TYPE.png }, maxBytes: png.length });

    const done = await put(alice, slot!.upload.url, png, TYPE.png);
    expect(done.status).toBe(200);
    const a = AssetSummary.parse(await done.json());
    expect(a).toMatchObject({ state: 'validated', mimeType: TYPE.png, sizeBytes: png.length, sha256: sha, image: { width: 1200, height: 800, mayHaveAlpha: false }, warnings: [] });

    const [row] = (await h.sql('SELECT owner_id, r2_key, sha256, state FROM assets WHERE id = $1', [a.id])).rows;
    expect(row!.r2_key).toBe(`users/${row!.owner_id}/assets/${a.id}/original`);
    expect(h.store.objects.get(row!.r2_key as string)?.bytes).toEqual(png);

    const read = await h.req(pathOf(a.contentUrl!), { origin: null }); // no cookie jar
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(png);
    expect(read.headers.get('content-type')).toBe(TYPE.png);
    expect(read.headers.get('x-content-type-options')).toBe('nosniff');
    expect(read.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
    expect(read.headers.get('content-disposition')).toBe('inline; filename="asset.png"');
    expect(read.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('accepts JPEG display images and GLB models with metadata', async () => {
    const jpg = await upload(alice, 'display-image', photoJpeg(), TYPE.jpeg);
    expect(jpg.image).toEqual({ width: 640, height: 427, mayHaveAlpha: false });
    const glb = await upload(alice, 'model', makeGlb(), TYPE.glb);
    expect(glb.model).toMatchObject({ gltfVersion: '2.0', meshes: 1, materials: 2 });
    const list = AssetListResponse.parse(await (await h.req('/api/assets?role=model', { jar: alice })).json());
    expect(list.assets.map((x) => x.id)).toContain(glb.id);
    expect(list.assets.every((x) => x.role === 'model' && x.contentUrl)).toBe(true);
    expect(list.usage.bytes).toBeGreaterThan(0);
  });

  it('validates reservations (400): role, type, size', async () => {
    const bad = async (body: Record<string, unknown>) => {
      const r = await h.req('/api/assets/uploads', { body: { role: 'display-image', filename: 'a', contentType: TYPE.png, sizeBytes: 100, ...body }, jar: alice });
      expect(r.status).toBe(400);
      return (await errorOf(r)).issues!.map((i) => i.message).join(' ');
    };
    expect(await bad({ role: 'usdz-override' })).not.toBe('');
    expect(await bad({ role: 'tracking-image', contentType: 'image/webp' })).toMatch(/Tracking images must be PNG or JPEG/);
    expect(await bad({ contentType: 'image/svg+xml' })).toMatch(/PNG, JPEG or WebP/);
    expect(await bad({ role: 'model', contentType: TYPE.png })).toMatch(/\.glb/);
    expect(await bad({ sizeBytes: 0 })).toMatch(/empty/);
    expect(await bad({ sizeBytes: 16 * 1024 * 1024 })).toMatch(/at most 15 MB/);
    expect(await bad({ sha256: 'ABC' })).toMatch(/SHA-256/);
  });
});

describe('rejected uploads', () => {
  async function rejected(role: UploadableRole, declared: Uint8Array, type: string, sent: Uint8Array, sentType = type, length?: string | null, extra: Record<string, unknown> = {}) {
    const { slot } = await reserve(alice, role, declared, type, extra);
    const r = await put(alice, slot!.upload.url, sent, sentType, length);
    const [row] = (await h.sql('SELECT state, rejection_code, r2_key FROM assets WHERE id = $1', [slot!.asset.id])).rows;
    expect(h.store.objects.has(row!.r2_key as string), 'nothing stored for a rejected upload').toBe(false);
    return { r, row: row!, slot: slot! };
  }

  it('a spoofed type is rejected (422), recorded, not stored, and the slot cannot be reused', async () => {
    const html = new TextEncoder().encode('<!doctype html><script>alert(document.cookie)</script>'.padEnd(2048, ' '));
    const { r, row, slot } = await rejected('display-image', html, TYPE.png, html);
    expect(r.status).toBe(422);
    expect(await errorOf(r)).toMatchObject({ code: 'invalid_file', reason: 'signature_mismatch' });
    expect(row).toMatchObject({ state: 'rejected', rejection_code: 'signature_mismatch' });
    const again = await put(alice, slot.upload.url, trackingPng(), TYPE.png);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).reason).toBe('upload_not_pending');
    const view = AssetSummary.parse(await (await h.req(`/api/assets/${slot.asset.id}`, { jar: alice })).json());
    expect(view).toMatchObject({ state: 'rejected', rejectionCode: 'signature_mismatch', contentUrl: null });
  });

  it('declared vs actual mismatches: type header, content (PNG declared as JPEG), length, checksum', async () => {
    const png = trackingPng();
    expect((await errorOf((await rejected('display-image', png, TYPE.png, png, TYPE.jpeg)).r)).reason).toBe('type_mismatch');
    expect((await errorOf((await rejected('display-image', png, TYPE.jpeg, png)).r)).reason).toBe('type_mismatch');
    expect((await errorOf((await rejected('display-image', png, TYPE.png, png.slice(0, -1), TYPE.png, String(png.length - 1))).r)).reason).toBe('size_mismatch');
    const lying = await rejected('display-image', png, TYPE.png, png, TYPE.png, String(png.length - 100)); // header lies about the length
    expect([422]).toContain(lying.r.status);
    expect((await errorOf((await rejected('display-image', png, TYPE.png, png, TYPE.png, undefined, { sha256: '0'.repeat(64) })).r)).reason).toBe('checksum_mismatch');
    const noLength = await rejected('display-image', png, TYPE.png, png, TYPE.png, null);
    expect(noLength.r.status).toBe(411);
  });

  it('decompression-bomb dimensions, truncated PNGs and GLBs with external references are rejected', async () => {
    const bomb = hugePng();
    expect((await errorOf((await rejected('display-image', bomb, TYPE.png, bomb)).r)).reason).toBe('dimensions_out_of_range');
    const cut = trackingPng().slice(0, -12);
    expect((await errorOf((await rejected('display-image', cut, TYPE.png, cut)).r)).reason).toBe('corrupt');
    const ext = makeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'https://evil.example/payload.bin' }] }, null);
    expect((await errorOf((await rejected('model', ext, TYPE.glb, ext)).r)).reason).toBe('external_reference');
  });

  it('an expired slot cannot be used (409)', async () => {
    const png = trackingPng();
    const { slot } = await reserve(alice, 'display-image', png, TYPE.png);
    await h.sql(`UPDATE assets SET upload_expires_at = now() - interval '1 second' WHERE id = $1`, [slot!.asset.id]);
    const r = await put(alice, slot!.upload.url, png, TYPE.png);
    expect(r.status).toBe(409);
    expect((await errorOf(r)).reason).toBe('upload_not_pending');
  });

  it('two simultaneous uploads into one slot: exactly one wins', async () => {
    const png = trackingPng();
    const { slot } = await reserve(alice, 'display-image', png, TYPE.png);
    const results = await Promise.all([put(alice, slot!.upload.url, png, TYPE.png), put(alice, slot!.upload.url, png, TYPE.png)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('isolation between users', () => {
  it("another user's asset is a 404 on every route, and their slot stays usable", async () => {
    const mine = await upload(alice, 'display-image', trackingPng(), TYPE.png);
    for (const [method, path] of [
      ['GET', `/api/assets/${mine.id}`],
      ['DELETE', `/api/assets/${mine.id}`],
    ] as const) {
      expect((await h.req(path, { method, jar: bob })).status, `${method} ${path}`).toBe(404);
    }
    const bobList = AssetListResponse.parse(await (await h.req('/api/assets', { jar: bob })).json());
    expect(bobList.assets.map((a) => a.id)).not.toContain(mine.id);

    const png = trackingPng();
    const { slot } = await reserve(alice, 'display-image', png, TYPE.png);
    expect((await put(bob, slot!.upload.url, png, TYPE.png)).status).toBe(404);
    expect((await put(alice, slot!.upload.url, png, TYPE.png)).status).toBe(200);
  });

  it('signed URLs: missing, tampered, expired and for deleted assets are refused', async () => {
    const a = await upload(alice, 'display-image', trackingPng(), TYPE.png);
    const url = new URL(a.contentUrl!);
    const base = url.pathname;
    expect((await h.req(base, { origin: null })).status).toBe(403);
    const tampered = new URLSearchParams(url.search);
    tampered.set('exp', String(Number(tampered.get('exp')) + 60));
    expect((await h.req(`${base}?${tampered}`, { origin: null })).status).toBe(403);
    expect((await h.req(`${base}?v=${url.searchParams.get('v')}&exp=1000&sig=${url.searchParams.get('sig')}`, { origin: null })).status).toBe(403);
    // A valid signature for one asset does not open another.
    const other = await upload(alice, 'display-image', photoJpeg(), TYPE.jpeg);
    expect((await h.req(`/api/assets/${other.id}/content${url.search}`, { origin: null })).status).toBe(403);
    expect((await h.req(`/api/assets/${a.id}`, { method: 'DELETE', jar: alice })).status).toBe(204);
    expect((await h.req(pathOf(a.contentUrl!), { origin: null })).status).toBe(404);
  });
});

describe('limits', () => {
  it('caps unfinished upload slots per user (429)', async () => {
    const carol = await signedIn();
    for (let i = 0; i < 10; i++) expect((await reserve(carol, 'model', makeGlb(), TYPE.glb)).r.status).toBe(201);
    const r = (await reserve(carol, 'model', makeGlb(), TYPE.glb)).r;
    expect(r.status).toBe(429);
    expect((await errorOf(r)).code).toBe('too_many_requests');
  });

  it('enforces the per-user storage quota (409 quota_exceeded)', async () => {
    const dave = await signedIn();
    const a = await upload(dave, 'model', makeGlb(), TYPE.glb);
    await h.sql('UPDATE assets SET size_bytes = $2 WHERE id = $1', [a.id, 1024 * 1024 * 1024 - 10]);
    const r = (await reserve(dave, 'display-image', trackingPng(), TYPE.png)).r;
    expect(r.status).toBe(409);
    expect((await errorOf(r)).reason).toBe('quota_exceeded');
  });
});

describe('experience drafts reference assets', () => {
  async function imageExperience(jar: Jar) {
    const r = await h.req('/api/experiences', { body: { name: 'Poster', placementMode: 'image' }, jar });
    return ExperienceDetail.parse(await r.json());
  }
  const saveTracking = (jar: Jar, e: ExperienceDetail, assetId: string | null, nodes: unknown[] = []) =>
    h.req(`/api/experiences/${e.id}/draft`, {
      method: 'PUT',
      body: { draftVersion: e.draftVersion, scene: { ...e.draft.scene, nodes, placement: { ...e.draft.scene.placement, trackingTargetAssetId: assetId } } },
      jar,
    });

  it('accepts own validated assets in the right role and refuses everything else', async () => {
    const tracking = await upload(alice, 'tracking-image', trackingPng(), TYPE.png);
    const display = await upload(alice, 'display-image', photoJpeg(), TYPE.jpeg);
    const bobs = await upload(bob, 'tracking-image', trackingPng(), TYPE.png);
    const e = await imageExperience(alice);

    const wrongRole = await saveTracking(alice, e, display.id);
    expect(wrongRole.status).toBe(400);
    expect((await errorOf(wrongRole)).issues).toEqual([{ path: ['scene', 'placement', 'trackingTargetAssetId'], message: 'This asset is a display image, not a tracking image.' }]);
    const foreign = await saveTracking(alice, e, bobs.id);
    expect((await errorOf(foreign)).issues![0]!.message).toBe('This asset does not exist or is not ready.');
    expect((await saveTracking(alice, e, 'not-a-uuid')).status).toBe(400);

    const ok = await saveTracking(alice, e, tracking.id);
    expect(ok.status).toBe(200);
    const saved = ExperienceDetail.parse(await ok.json());
    expect(saved.draft.scene.placement).toMatchObject({ trackingTargetAssetId: tracking.id });
    const ready = ReadinessResponse.parse(await (await h.req(`/api/experiences/${e.id}/validate`, { body: {}, jar: alice })).json());
    expect(ready.issues.map((i) => i.code)).not.toContain('tracking_image_missing');
  });

  it('model nodes must reference own model assets', async () => {
    const model = await upload(alice, 'model', makeGlb(), TYPE.glb);
    const image = await upload(alice, 'display-image', photoJpeg(), TYPE.jpeg);
    const e = await imageExperience(alice);
    const node = (assetId: string) => ({ id: 'n1', kind: 'model', assetId, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true, locked: false });
    const bad = await saveTracking(alice, e, null, [node(image.id)]);
    expect((await errorOf(bad)).issues).toEqual([{ path: ['scene', 'nodes', 0, 'assetId'], message: 'This asset is a display image, not a 3D model.' }]);
    expect((await saveTracking(alice, e, null, [node(model.id)])).status).toBe(200);
  });

  it('an asset in use cannot be deleted; once unreferenced it is deleted with its stored object', async () => {
    const tracking = await upload(alice, 'tracking-image', trackingPng(), TYPE.png);
    const e = await imageExperience(alice);
    const saved = ExperienceDetail.parse(await (await saveTracking(alice, e, tracking.id)).json());
    const blocked = await h.req(`/api/assets/${tracking.id}`, { method: 'DELETE', jar: alice });
    expect(blocked.status).toBe(409);
    expect(await errorOf(blocked)).toMatchObject({ reason: 'asset_in_use', message: expect.stringContaining('“Poster”') });

    expect((await saveTracking(alice, saved, null)).status).toBe(200);
    const [row] = (await h.sql('SELECT r2_key FROM assets WHERE id = $1', [tracking.id])).rows;
    expect((await h.req(`/api/assets/${tracking.id}`, { method: 'DELETE', jar: alice })).status).toBe(204);
    expect(h.store.objects.has(row!.r2_key as string)).toBe(false);
    expect((await h.sql('SELECT 1 FROM assets WHERE id = $1', [tracking.id])).rowCount).toBe(0);
  });
});

const keyOf = async (id: string) => ((await h.sql('SELECT r2_key FROM assets WHERE id = $1', [id])).rows[0] as { r2_key: string }).r2_key;

describe('maintenance sweep (ADR-039)', () => {
  it('deletes long-expired slots and week-old rejected uploads (rows and objects), keeps everything else, and is idempotent', async () => {
    const png = trackingPng();
    // 1. a slot never used, expired 2 h ago (with a stray object at its key, e.g. a crashed upload);
    const { slot: old } = await reserve(alice, 'display-image', png, TYPE.png);
    await h.sql("UPDATE assets SET upload_expires_at = now() - interval '2 hours' WHERE id = $1", [old!.asset.id]);
    const oldKey = await keyOf(old!.asset.id);
    await h.store.put(oldKey, new Blob([png]).stream(), { size: png.length, contentType: TYPE.png });
    // 2. a slot expired only 10 minutes ago (inside the grace period) — kept;
    const { slot: recent } = await reserve(alice, 'display-image', png, TYPE.png);
    await h.sql("UPDATE assets SET upload_expires_at = now() - interval '10 minutes' WHERE id = $1", [recent!.asset.id]);
    // 3. a rejected upload from 8 days ago — deleted; 4. one rejected today — kept;
    const rejectOne = async () => {
      const { slot } = await reserve(alice, 'display-image', png, TYPE.png);
      expect((await put(alice, slot!.upload.url, png, 'image/jpeg')).status).toBe(422);
      return slot!.asset.id;
    };
    const oldRejected = await rejectOne();
    await h.sql("UPDATE assets SET created_at = now() - interval '8 days' WHERE id = $1", [oldRejected]);
    const newRejected = await rejectOne();
    // 5. a validated asset created long ago — kept with its object; 6. an idle and an active rate-limit row.
    const kept = await upload(alice, 'display-image', png, TYPE.png);
    await h.sql("UPDATE assets SET created_at = now() - interval '30 days' WHERE id = $1", [kept.id]);
    await h.sql("INSERT INTO rate_limit (id, key, count, last_request) VALUES ('app:public-read:idle', 'app:public-read:idle', 3, $1), ('app:public-read:busy', 'app:public-read:busy', 3, $2)", [Date.now() - 2 * 3600_000, Date.now()]);

    const handle = await connectDb(temp.url);
    try {
      const r = await sweep(handle.db, h.store);
      expect(r.expiredSlots).toBeGreaterThanOrEqual(1);
      expect(r.rejected).toBeGreaterThanOrEqual(1);
      expect(r.objectDeleteFailures).toBe(0);
      expect(r.rateLimitRows).toBeGreaterThanOrEqual(1);
      const left = new Set(((await h.sql('SELECT id FROM assets')).rows as { id: string }[]).map((x) => x.id));
      expect(left.has(old!.asset.id)).toBe(false);
      expect(left.has(oldRejected)).toBe(false);
      expect(left.has(recent!.asset.id)).toBe(true);
      expect(left.has(newRejected)).toBe(true);
      expect(left.has(kept.id)).toBe(true);
      expect(h.store.objects.has(oldKey)).toBe(false);
      const keptKey = await keyOf(kept.id);
      expect(h.store.objects.has(keptKey)).toBe(true);
      const keys = ((await h.sql("SELECT key FROM rate_limit WHERE key LIKE 'app:public-read:%'")).rows as { key: string }[]).map((x) => x.key);
      expect(keys).toEqual(['app:public-read:busy']);
      // The kept asset still downloads; a second run finds nothing to do.
      expect((await h.req(pathOf(kept.contentUrl!))).status).toBe(200);
      expect(await sweep(handle.db, h.store)).toEqual({ expiredSlots: 0, rejected: 0, objectDeleteFailures: 0, rateLimitRows: 0 });
      // An object that cannot be deleted is reported, and its row is still removed.
      const { slot: broken } = await reserve(alice, 'display-image', png, TYPE.png);
      await h.sql("UPDATE assets SET upload_expires_at = now() - $2::interval WHERE id = $1", [broken!.asset.id, `${SWEEP.pendingGraceMs / 1000 + 60} seconds`]);
      const failing = { ...h.store, delete: async () => Promise.reject(new Error('R2 down')) };
      const logs: string[] = [];
      expect(await sweep(handle.db, failing, new Date(), (d) => logs.push(d))).toMatchObject({ expiredSlots: 1, objectDeleteFailures: 1 });
      expect(logs[0]).toContain('R2 down');
    } finally {
      await handle.close();
    }
  });

  it('an upload finishing after its slot was swept is cancelled and leaves no object behind', async () => {
    const png = trackingPng();
    const { slot } = await reserve(alice, 'display-image', png, TYPE.png);
    // Simulate: the upload claimed the slot before expiry, then the sweep deleted the row while bytes were streaming.
    const key = await keyOf(slot!.asset.id);
    await h.sql('DELETE FROM assets WHERE id = $1', [slot!.asset.id]);
    const r = await put(alice, slot!.upload.url, png, TYPE.png);
    expect([404, 409]).toContain(r.status);
    expect(h.store.objects.has(key)).toBe(false);
  });
});

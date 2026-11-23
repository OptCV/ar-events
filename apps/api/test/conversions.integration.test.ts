/**
 * Phase 2 Milestone 1 — Image-to-AR conversion API against local Docker Postgres, the in-memory object store and the
 * REAL converter image (`npm run usd:serve`, the image Cloudflare Containers run). Conversions run through the
 * inline runner, which executes the same pipeline steps as the Workflow (the Workflow itself runs in `vite dev`,
 * covered by Playwright).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, AssetListResponse, AssetSummary, ConversionListResponse, ConversionSummary, CreateUploadResponse, ExperienceDetail, ImageObjectListResponse, type ImageObjectSettingsInput, type UploadableRole } from '@ar-creator/contracts';
import { IDENTITY_TRANSFORM } from '@ar-creator/schema';
import { PNG } from 'pngjs';
import { physicalSize, readGlb } from '@ar-creator/image-to-ar';
import { createTempDatabase, migrateDatabase } from '../../../packages/db/test/helpers.ts';
import { fixture, makeGlb, photoJpeg, sha256Hex, trackingPng } from './files.ts';
import { Jar, LOCAL_USD_URL, PASSWORD, linkIn, makeHarness, uniqueEmail, type Harness } from './harness.ts';
import { httpUsdConverter, UsdConverterUnavailable, type UsdConverter } from '../src/conversions/usd.ts';

let temp: Awaited<ReturnType<typeof createTempDatabase>>;
let h: Harness;
let alice: Jar;
let bob: Jar;

/** Real converter, with switches to simulate an outage or hold conversions in flight. */
const real = httpUsdConverter((r) => fetch(r), LOCAL_USD_URL);
const control = { down: false, gate: null as Promise<void> | null, calls: 0, textureCalls: 0 };
const usd: UsdConverter = {
  async imagePlane(...args) {
    control.calls++;
    if (control.gate) await control.gate;
    if (control.down) throw new UsdConverterUnavailable('simulated outage');
    return real.imagePlane(...args);
  },
  async prepareTexture(...args) {
    control.textureCalls++;
    if (control.gate) await control.gate;
    if (control.down) throw new UsdConverterUnavailable('simulated outage');
    return real.prepareTexture(...args);
  },
  scene: (...args) => real.scene(...args),
};

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../tests/fixtures/manifest.json', import.meta.url).href), 'utf8')) as { fixtures: { file: string; role: string; expectedAutoAlpha: string; sha256: string }[] };
const DISPLAY = manifest.fixtures.filter((f) => f.role === 'display-image');
const typeOf = (file: string) => (file.endsWith('.jpg') ? 'image/jpeg' : 'image/png');

async function signedIn(): Promise<Jar> {
  const email = uniqueEmail();
  const before = h.mails.length;
  await h.req('/api/auth/sign-up/email', { body: { name: 'Creator', email, password: PASSWORD, callbackURL: '/email-verified' } });
  await h.req(linkIn(h.mails.slice(before).find((m) => m.to === email)).replace(/^https?:\/\/[^/]+/, ''));
  const jar = new Jar();
  expect((await h.req('/api/auth/sign-in/email', { body: { email, password: PASSWORD }, jar })).status).toBe(200);
  return jar;
}

async function upload(jar: Jar, role: UploadableRole, bytes: Uint8Array, type: string, filename = 'poster.png') {
  const s = await h.req('/api/assets/uploads', { body: { role, filename, contentType: type, sizeBytes: bytes.length }, jar });
  const slot = CreateUploadResponse.parse(await s.json());
  const r = await h.req(slot.upload.url, { method: 'PUT', raw: { bytes, type }, jar });
  expect(r.status, await r.clone().text()).toBe(200);
  return AssetSummary.parse(await r.json());
}

const settings = (s: Partial<ImageObjectSettingsInput> = {}): ImageObjectSettingsInput => ({ widthMeters: 0.5, shapeMode: 'flat', alphaMode: 'auto', ...s });
const start = (jar: Jar, assetId: string, s: ImageObjectSettingsInput = settings()) => h.req(`/api/assets/${assetId}/image-objects`, { body: { settings: s }, jar });
async function convert(jar: Jar, assetId: string, s: ImageObjectSettingsInput = settings()) {
  const r = await start(jar, assetId, s);
  expect([200, 202], await r.clone().text()).toContain(r.status);
  const first = ConversionSummary.parse(await r.json());
  await h.conversions.idle();
  return ConversionSummary.parse(await (await h.req(`/api/conversions/${first.id}`, { jar })).json());
}
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');
const anon = (url: string) => h.req(pathOf(url), { origin: null });
const errorOf = async (r: Response) => ApiError.parse(await r.json()).error;

/** Stored (uncompressed) zip entries, as USDZ requires. */
function zipEntries(b: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  while (o + 30 <= b.length && dv.getUint32(o, true) === 0x04034b50) {
    expect(dv.getUint16(o + 8, true), 'USDZ entries must be stored, not compressed').toBe(0);
    const size = dv.getUint32(o + 18, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extra = dv.getUint16(o + 28, true);
    const name = new TextDecoder().decode(b.subarray(o + 30, o + 30 + nameLen));
    const start = o + 30 + nameLen + extra;
    expect(start % 64, `${name} must be 64-byte aligned`).toBe(0);
    out.set(name, b.subarray(start, start + size));
    o = start + size;
  }
  return out;
}

/** GLB and USDZ embed byte-identical textures; `original`: those bytes are the uploaded file (ADR-009). */
async function expectSameTexture(conv: ConversionSummary, original: boolean, sourceSha?: string) {
  const glb = new Uint8Array(await (await anon(conv.outputs.glb!.contentUrl!)).arrayBuffer());
  const { json, bin } = readGlb(glb);
  const view = json.bufferViews[json.images[0].bufferView];
  const glbTex = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
  expect(json.images[0].mimeType).toBe(conv.texture!.mimeType);
  const usdz = new Uint8Array(await (await anon(conv.outputs.usdz!.contentUrl!)).arrayBuffer());
  const tex = [...zipEntries(usdz)].filter(([n]) => n.includes('display'));
  expect(tex).toHaveLength(1);
  expect(await sha256Hex(tex[0]![1])).toBe(await sha256Hex(glbTex));
  if (original) expect(await sha256Hex(glbTex)).toBe(sourceSha);
  else if (sourceSha) expect(await sha256Hex(glbTex)).not.toBe(sourceSha);
}

beforeAll(async () => {
  const health = await fetch(`${LOCAL_USD_URL}/healthz`).catch(() => null);
  if (!health?.ok) throw new Error(`The local USD converter is not running at ${LOCAL_USD_URL}. Start it with: npm run usd:serve -- --detach`);
  temp = await createTempDatabase();
  await migrateDatabase(temp.url);
  h = makeHarness({ dbUrl: temp.url, usd });
  alice = await signedIn();
  bob = await signedIn();
});
afterAll(async () => {
  await h?.conversions.idle();
  await temp?.drop();
});

describe('access control', () => {
  it('session routes need a session; derivative reads need a valid signature', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await h.req(`/api/assets/${id}/image-objects`, { body: { settings: settings() } })).status).toBe(401);
    expect((await h.req(`/api/assets/${id}/image-objects`)).status).toBe(401);
    expect((await h.req(`/api/conversions/${id}`)).status).toBe(401);
    expect((await h.req(`/api/derivatives/${id}/content`, { origin: null })).status).toBe(404);
    expect((await h.req('/api/derivatives/not-a-uuid/content', { origin: null })).status).toBe(404);
  });

  it("another user's image and conversions are 404", async () => {
    const a = await upload(alice, 'display-image', fixture('ring_inner_hole.png'), 'image/png');
    const conv = await convert(alice, a.id);
    expect((await start(bob, a.id)).status).toBe(404);
    expect((await h.req(`/api/assets/${a.id}/image-objects`, { jar: bob })).status).toBe(404);
    expect((await h.req(`/api/conversions/${conv.id}`, { jar: bob })).status).toBe(404);
  });

  it('cross-origin starts are refused (403)', async () => {
    const a = await upload(alice, 'display-image', photoJpeg(), 'image/jpeg', 'photo.jpg');
    expect((await h.req(`/api/assets/${a.id}/image-objects`, { body: { settings: settings() }, jar: alice, origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('every display fixture converts to a matching GLB + USDZ pair', () => {
  for (const f of DISPLAY) {
    it(`${f.file} → auto alpha ${f.expectedAutoAlpha}`, async () => {
      const src = fixture(f.file);
      const a = await upload(alice, 'display-image', src, typeOf(f.file), f.file);
      const conv = await convert(alice, a.id, settings({ widthMeters: 0.4, pivot: 'bottom-center', doubleSided: true }));
      expect(conv.state, JSON.stringify(conv.error)).toBe('succeeded');
      expect(conv.resolvedAlphaMode).toBe(f.expectedAutoAlpha);
      const size = physicalSize(a.image!.width, a.image!.height, 0.4);
      expect(conv.widthMeters).toBe(size.widthMeters);
      expect(conv.heightMeters).toBe(size.heightMeters);
      expect(conv.alpha === null).toBe(f.file.endsWith('.jpg'));
      expect(conv.texture).toMatchObject({ changes: [], width: a.image!.width, height: a.image!.height });

      // GLB: cookieless signed read, exact bytes, the original image embedded unmodified (ADR-009).
      const glbOut = conv.outputs.glb!;
      expect(glbOut).toMatchObject({ state: 'ready', format: 'glb', downloadName: `${f.file.replace(/\.\w+$/, '')}-image-object.glb` });
      const g = await anon(glbOut.contentUrl!);
      expect(g.status).toBe(200);
      expect(g.headers.get('content-type')).toBe('model/gltf-binary');
      expect(g.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
      // Native viewers fetch from another origin (ADR-026): readable cross-origin only with a valid signature.
      expect(g.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(g.headers.get('access-control-allow-origin')).toBe('*');
      const bad = await anon(glbOut.contentUrl!.replace(/sig=[^&]+/, 'sig=AAAA'));
      expect(bad.status).toBe(403);
      expect(bad.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(bad.headers.get('access-control-allow-origin')).toBeNull();
      const glb = new Uint8Array(await g.arrayBuffer());
      expect(await sha256Hex(glb)).toBe(glbOut.sha256);
      const { json, bin } = readGlb(glb);
      expect(json.materials[0].alphaMode).toBe(f.expectedAutoAlpha);
      expect(json.materials[0].doubleSided).toBe(true);
      const view = json.bufferViews[json.images[0].bufferView];
      expect(await sha256Hex(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength))).toBe(f.sha256);

      // USDZ: correct MIME for Quick Look, stored + aligned entries, the same original texture bytes.
      const usdzOut = conv.outputs.usdz!;
      const u = await anon(usdzOut.contentUrl!);
      expect(u.status).toBe(200);
      expect(u.headers.get('content-type')).toBe('model/vnd.usdz+zip');
      const usdz = new Uint8Array(await u.arrayBuffer());
      expect(await sha256Hex(usdz)).toBe(usdzOut.sha256);
      const entries = zipEntries(usdz);
      expect([...entries.keys()][0]).toBe('scene.usdc');
      const tex = [...entries].filter(([n]) => n.includes('display'));
      expect(tex).toHaveLength(1);
      expect(await sha256Hex(tex[0]![1])).toBe(f.sha256);
    });
  }
});

describe('reuse and idempotency', () => {
  it('the same settings reuse the job and its outputs; equivalent spellings hash equally', async () => {
    const a = await upload(alice, 'display-image', fixture('alpha_steps.png'), 'image/png');
    const first = await convert(alice, a.id, settings({ alphaCutoff: 0.5, doubleSided: false, pivot: 'center', orientation: 'upright' }));
    const calls = control.calls;
    const again = await start(alice, a.id, settings()); // defaults omitted, same meaning
    expect(again.status).toBe(200);
    expect(ConversionSummary.parse(await again.json())).toMatchObject({ id: first.id, state: 'succeeded' });
    expect(control.calls).toBe(calls); // no new work
    const n = await h.sql('SELECT count(*)::int AS n FROM asset_derivatives WHERE source_asset_id = $1', [a.id]);
    expect(n.rows[0]!.n).toBe(2);

    const wider = await convert(alice, a.id, settings({ widthMeters: 1 }));
    expect(wider.id).not.toBe(first.id);
    expect(wider.outputs.glb!.id).not.toBe(first.outputs.glb!.id);
    const list = ConversionListResponse.parse(await (await h.req(`/api/assets/${a.id}/image-objects`, { jar: alice })).json());
    expect(list.conversions.map((c) => c.id).sort()).toEqual([first.id, wider.id].sort());
  });

  it('outputs count toward storage usage', async () => {
    const before = AssetListResponse.parse(await (await h.req('/api/assets', { jar: bob })).json()).usage.bytes;
    const a = await upload(bob, 'display-image', fixture('wide_npot.png'), 'image/png');
    const conv = await convert(bob, a.id);
    const after = AssetListResponse.parse(await (await h.req('/api/assets', { jar: bob })).json()).usage.bytes;
    expect(after - before).toBe(a.sizeBytes! + conv.outputs.glb!.sizeBytes! + conv.outputs.usdz!.sizeBytes!);
  });
});

describe('refusals and failures', () => {
  it('only validated display images can be converted (409 not_convertible)', async () => {
    const tracking = await upload(alice, 'tracking-image', trackingPng(), 'image/png');
    const model = await upload(alice, 'model', makeGlb(), 'model/gltf-binary', 'm.glb');
    for (const id of [tracking.id, model.id]) {
      const r = await start(alice, id);
      expect(r.status).toBe(409);
      expect((await errorOf(r)).reason).toBe('not_convertible');
    }
    const pending = CreateUploadResponse.parse(await (await h.req('/api/assets/uploads', { body: { role: 'display-image', filename: 'p.png', contentType: 'image/png', sizeBytes: 100 }, jar: alice })).json());
    expect((await start(alice, pending.asset.id)).status).toBe(409);
  });

  it('invalid settings are 400 with field issues', async () => {
    const a = await upload(alice, 'display-image', fixture('wide_npot.png'), 'image/png');
    for (const bad of [{ widthMeters: 0 }, { widthMeters: 21 }, { alphaMode: 'SOMETIMES' }, { shapeMode: 'extruded' }, { alphaCutoff: 2 }]) {
      const r = await start(alice, a.id, settings(bad as Partial<ImageObjectSettingsInput>));
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((await errorOf(r)).issues?.length).toBeGreaterThan(0);
    }
  });

  it('OPAQUE on an image with transparency fails with a clear message, and writes nothing', async () => {
    const a = await upload(alice, 'display-image', fixture('logo_transparent_border.png'), 'image/png');
    const conv = await convert(alice, a.id, settings({ alphaMode: 'OPAQUE' }));
    expect(conv.state).toBe('failed');
    expect(conv.error).toMatchObject({ code: 'invalid_settings' });
    expect(conv.error!.message).toMatch(/transparent pixels/);
    expect(conv.outputs).toEqual({ glb: null, usdz: null });
  });

  it('a rotated JPEG (EXIF orientation 6) is turned upright once and both files embed that texture (ADR-025)', async () => {
    const jpeg = photoJpeg();
    const tiff = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
    const body = new Uint8Array([...new TextEncoder().encode('Exif\0\0'), ...tiff]);
    const seg = new Uint8Array([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]);
    const rotated = new Uint8Array([...jpeg.subarray(0, 2), ...seg, ...jpeg.subarray(2)]);
    const a = await upload(alice, 'display-image', rotated, 'image/jpeg', 'rotated.jpg');
    const conv = await convert(alice, a.id);
    expect(conv.state, JSON.stringify(conv.error)).toBe('succeeded');
    const { width: w, height: h } = a.image!;
    // Upright: width and height swap; still a JPEG (opaque, lossy source); within budget so not resized.
    expect(conv.texture).toEqual({ mimeType: 'image/jpeg', width: h, height: w, sourceWidth: w, sourceHeight: h, changes: ['rotated'] });
    expect(conv).toMatchObject({ resolvedAlphaMode: 'OPAQUE', heightMeters: physicalSize(h, w, 0.5).heightMeters });
    await expectSameTexture(conv, false);
  });

  it('WebP: lossless with transparency → PNG texture (alpha kept, Cutout/Blend as before); lossy photo → JPEG', async () => {
    const cases = [
      ['logo_alpha_lossless.webp', 'image/png', 'MASK'],
      ['disc_soft_alpha.webp', 'image/png', 'BLEND'],
      ['photo_lossy.webp', 'image/jpeg', 'OPAQUE'],
    ] as const;
    for (const [file, mime, alpha] of cases) {
      const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/normalize/${file}`, import.meta.url).href)));
      const a = await upload(alice, 'display-image', bytes, 'image/webp', file);
      expect(a).toMatchObject({ mimeType: 'image/webp', state: 'validated' });
      const conv = await convert(alice, a.id);
      expect(conv.state, `${file}: ${JSON.stringify(conv.error)}`).toBe('succeeded');
      expect(conv.texture, file).toMatchObject({ mimeType: mime, width: a.image!.width, height: a.image!.height, changes: ['converted'] });
      expect(conv.resolvedAlphaMode, file).toBe(alpha);
      await expectSameTexture(conv, false);
    }
  });

  it('an image above the 2048 px budget is downscaled once (premultiplied), keeping its alpha and aspect ratio', async () => {
    // 3000 × 1000 RGBA: opaque centre band, binary alpha → Cutout, resized to 2048 × 683.
    const png = new PNG({ width: 3000, height: 1000 });
    for (let y = 0; y < 1000; y++)
      for (let x = 0; x < 3000; x++) {
        const i = (y * 3000 + x) * 4;
        const inside = y > 250 && y < 750;
        png.data.set(inside ? [20, 120, 220, 255] : [0, 0, 0, 0], i);
      }
    const bytes = new Uint8Array(PNG.sync.write(png));
    const a = await upload(alice, 'display-image', bytes, 'image/png', 'banner.png');
    const conv = await convert(alice, a.id, settings({ widthMeters: 1.5 }));
    expect(conv.state, JSON.stringify(conv.error)).toBe('succeeded');
    expect(conv.texture).toEqual({ mimeType: 'image/png', width: 2048, height: 683, sourceWidth: 3000, sourceHeight: 1000, changes: ['resized'] });
    expect(conv.resolvedAlphaMode).not.toBe('OPAQUE');
    // Physical size follows the texture's aspect ratio (683/2048 vs the original 1/3: within one pixel).
    expect(conv.widthMeters).toBe(1.5);
    expect(Math.abs(conv.heightMeters! - 0.5)).toBeLessThan(1.5 / 2048);
    await expectSameTexture(conv, false);
    // The prepared texture is stored once and counts toward usage; the same source with other settings reuses it.
    const before = control.textureCalls;
    const again = await convert(alice, a.id, settings({ widthMeters: 2 }));
    expect(again.texture).toEqual(conv.texture);
    expect(control.textureCalls).toBe(before);
    const textures = await h.sql("SELECT count(*)::int AS n FROM asset_derivatives WHERE source_asset_id = $1 AND output_type = 'image_object_texture' AND status = 'ready'", [a.id]);
    expect(textures.rows[0]!.n).toBe(1);
  });

  it('a converter outage fails the attempt; starting again retries the same job (attempt 2) and succeeds', async () => {
    const a = await upload(alice, 'display-image', fixture('tall_npot.png'), 'image/png');
    control.down = true;
    const failed = await convert(alice, a.id);
    control.down = false;
    expect(failed).toMatchObject({ state: 'failed', attempt: 1, error: { code: 'converter_unavailable' } });
    // The GLB step finished before the outage and is reused, not rebuilt.
    const glbRows = await h.sql("SELECT id FROM asset_derivatives WHERE source_asset_id = $1 AND output_type = 'image_object_glb' AND status = 'ready'", [a.id]);
    expect(glbRows.rows).toHaveLength(1);
    expect(failed.outputs.usdz).toBeNull();

    const retried = await convert(alice, a.id);
    expect(retried).toMatchObject({ id: failed.id, state: 'succeeded', attempt: 2, error: null });
    expect(retried.outputs.glb!.id).toBe(glbRows.rows[0]!.id);
  });

  it('after maxAttempts failures the job is returned as-is (no endless retries)', async () => {
    const a = await upload(alice, 'display-image', fixture('ring_inner_hole.png'), 'image/png');
    control.down = true;
    try {
      for (let i = 1; i <= 3; i++) expect((await convert(alice, a.id, settings({ widthMeters: 0.33 }))).attempt).toBe(i);
      const r = await start(alice, a.id, settings({ widthMeters: 0.33 }));
      expect(r.status).toBe(200);
      expect(ConversionSummary.parse(await r.json())).toMatchObject({ state: 'failed', attempt: 3 });
    } finally {
      control.down = false;
    }
  });
});

describe('limits, deletion and signed reads', () => {
  it('at most 3 active conversions per user (429); the source cannot be deleted while converting (409)', async () => {
    let release!: () => void;
    control.gate = new Promise<void>((r) => (release = r));
    try {
      const imgs = await Promise.all(['wide_npot.png', 'tall_npot.png', 'alpha_steps.png', 'ring_inner_hole.png'].map((f) => upload(bob, 'display-image', fixture(f), 'image/png', f)));
      for (const img of imgs.slice(0, 3)) expect((await start(bob, img.id, settings({ widthMeters: 0.77 }))).status).toBe(202);
      const fourth = await start(bob, imgs[3]!.id, settings({ widthMeters: 0.77 }));
      expect(fourth.status).toBe(429);
      expect((await errorOf(fourth)).code).toBe('too_many_requests');
      const del = await h.req(`/api/assets/${imgs[0]!.id}`, { method: 'DELETE', jar: bob });
      expect(del.status).toBe(409);
      expect((await errorOf(del)).reason).toBe('conversion_running');
    } finally {
      control.gate = null;
      release();
      await h.conversions.idle();
    }
  });

  it('signatures are bound to kind, id and content; deleting the source removes every generated object', async () => {
    const a = await upload(alice, 'display-image', fixture('aa_disc_dark_fringe.png'), 'image/png');
    const conv = await convert(alice, a.id);
    const glb = new URL(conv.outputs.glb!.contentUrl!, h.base);
    const usdz = new URL(conv.outputs.usdz!.contentUrl!, h.base);

    // Tampered signature, another output's signature, and an asset-read signature on the derivative path.
    const t = new URL(glb);
    t.searchParams.set('sig', 'A'.repeat(43));
    expect((await anon(t.href)).status).toBe(403);
    expect((await anon(`/api/derivatives/${conv.outputs.usdz!.id}/content${glb.search}`)).status).toBe(403);
    const assetSigned = new URL(a.contentUrl!, h.base);
    expect((await anon(`/api/derivatives/${a.id}/content${assetSigned.search}`)).status).toBe(404); // not a derivative id
    expect((await anon(`/api/assets/${conv.outputs.glb!.id}/content${glb.search}`)).status).toBe(404); // not an asset id
    expect((await anon(`${glb.pathname}${glb.search}&download=1`)).headers.get('content-disposition')).toMatch(/^attachment; filename="poster-image-object\.glb"$/);

    const keys = (await h.sql('SELECT r2_key FROM asset_derivatives WHERE source_asset_id = $1', [a.id])).rows.map((r) => String(r.r2_key));
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(h.store.objects.has(k)).toBe(true);
    expect((await h.req(`/api/assets/${a.id}`, { method: 'DELETE', jar: alice })).status).toBe(204);
    for (const k of keys) expect(h.store.objects.has(k), k).toBe(false);
    expect((await anon(glb.pathname + glb.search)).status).toBe(404);
    expect((await anon(usdz.pathname + usdz.search)).status).toBe(404);
    expect((await h.sql('SELECT count(*)::int AS n FROM asset_derivatives WHERE source_asset_id = $1', [a.id])).rows[0]!.n).toBe(0);
  });
});

describe('image objects in experiences (M7)', () => {
  const node = (derivativeId: string) => ({ id: 'io1', kind: 'image-object', derivativeId, name: 'Ring', transform: IDENTITY_TRANSFORM, visible: true, locked: false });
  async function experience(jar: Jar) {
    const r = await h.req('/api/experiences', { body: { name: 'Gallery', placementMode: 'wall' }, jar });
    return ExperienceDetail.parse(await r.json());
  }
  const save = (jar: Jar, e: ExperienceDetail, nodes: unknown[]) =>
    h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { draftVersion: e.draftVersion, scene: { ...e.draft.scene, nodes } }, jar });

  it('lists only complete GLB + USDZ pairs, with a source preview, newest first', async () => {
    const carol = await signedIn();
    expect(ImageObjectListResponse.parse(await (await h.req('/api/image-objects', { jar: carol })).json()).imageObjects).toEqual([]);
    const a = await upload(carol, 'display-image', fixture('ring_inner_hole.png'), 'image/png', 'ring.png');
    const ok = await convert(carol, a.id);
    const bad = await convert(carol, a.id, settings({ alphaMode: 'OPAQUE' })); // fails: has transparency
    expect(bad.state).toBe('failed');
    const list = ImageObjectListResponse.parse(await (await h.req('/api/image-objects', { jar: carol })).json()).imageObjects;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: ok.outputs.glb!.id, conversionId: ok.id, sourceAssetId: a.id, sourceFilename: 'ring.png', resolvedAlphaMode: 'MASK' });
    expect((await anon(list[0]!.previewUrl!)).status).toBe(200);
    expect((await h.req('/api/image-objects')).status).toBe(401);
    expect(ImageObjectListResponse.parse(await (await h.req('/api/image-objects', { jar: bob })).json()).imageObjects.map((i) => i.id)).not.toContain(ok.outputs.glb!.id);
  });

  it('drafts accept the GLB id of a complete pair only; the source cannot be deleted while placed', async () => {
    const a = await upload(alice, 'display-image', fixture('ring_inner_hole.png'), 'image/png', 'ring.png');
    const conv = await convert(alice, a.id, settings({ widthMeters: 0.61 }));
    const e = await experience(alice);

    for (const wrong of [conv.outputs.usdz!.id, '00000000-0000-4000-8000-000000000000', a.id]) {
      const r = await save(alice, e, [node(wrong)]);
      expect(r.status, wrong).toBe(400);
      expect(JSON.stringify(await r.json())).toContain('This image object does not exist or is not ready.');
    }
    // Another user cannot reference it.
    const eb = await experience(bob);
    expect((await save(bob, eb, [node(conv.outputs.glb!.id)])).status).toBe(400);

    const saved = await save(alice, e, [node(conv.outputs.glb!.id)]);
    expect(saved.status, await saved.clone().text()).toBe(200);
    const after = ExperienceDetail.parse(await saved.json());
    expect(after.draft.scene.nodes).toMatchObject([{ kind: 'image-object', derivativeId: conv.outputs.glb!.id }]);

    const blocked = await h.req(`/api/assets/${a.id}`, { method: 'DELETE', jar: alice });
    expect(blocked.status).toBe(409);
    expect(await errorOf(blocked)).toMatchObject({ reason: 'asset_in_use', message: expect.stringContaining('“Gallery”') });

    const cleared = await save(alice, after, []);
    expect(cleared.status).toBe(200);
    expect((await h.req(`/api/assets/${a.id}`, { method: 'DELETE', jar: alice })).status).toBe(204);
  });
});

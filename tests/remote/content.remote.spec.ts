/**
 * Remote Milestone 4/5 checks on Cloudflare's edge: dev Worker → Hyperdrive → Neon development (experiences, asset
 * rows) and dev Worker → R2 `ar-creator-assets-dev` (bytes). Uses the temporary verified user seeded by db:remote.
 *
 * Runs after auth.remote.spec.ts (files run alphabetically, one worker). That suite deliberately exhausts the
 * 5/min sign-in budget for this IP, so the single sign-in here waits for the window to reset.
 *
 * Every object this suite writes to R2 is deleted through the API before it ends (the user cleanup in db:remote
 * cascades database rows only; it cannot reach R2). The final test asserts nothing is left behind.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { expect, request as pwRequest, test, type APIRequestContext } from '@playwright/test';
import { ApiError, AssetListResponse, AssetSummary, BuildSummary, ConversionSummary, CreateUploadResponse, ExperienceDetail, PublicationStatus, TestBuildResponse } from '@ar-creator/contracts';
import { parseSceneViewerIntent } from '@ar-creator/platform-launch';

test.describe.configure({ mode: 'serial' });

const BASE = process.env.REMOTE_BASE_URL!;
const EMAIL = process.env.REMOTE_TEST_EMAIL!;
const PASSWORD = process.env.REMOTE_TEST_PASSWORD!;
const json = { 'content-type': 'application/json', origin: BASE };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const tracking = readFileSync('tests/fixtures/images/tracking_target_20cm.png'); // 1200×800
function glb(): Buffer {
  const body = Buffer.from(JSON.stringify({ asset: { version: '2.0', generator: 'remote' }, meshes: [{}] }).padEnd(56, ' '));
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + body.length, 8);
  head.writeUInt32LE(body.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, body]);
}
/** Deterministic noise PNG (incompressible): ~10.8 MB, many network chunks, real hashing work in the Worker. */
function noisePng(w = 1900, h = 1900): Buffer {
  const png = new PNG({ width: w, height: h, colorType: 2, inputHasAlpha: false });
  let s = 0x2545f491;
  for (let i = 0; i < png.data.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    png.data[i] = (i & 3) === 3 ? 255 : s & 255;
  }
  return PNG.sync.write(png, { colorType: 2, deflateLevel: 1 });
}

let api: APIRequestContext;
const created = { assets: new Set<string>(), experiences: new Set<string>() };

async function signInWhenAllowed(ctx: APIRequestContext) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await ctx.post('/api/auth/sign-in/email', { headers: json, data: { email: EMAIL, password: PASSWORD } });
    if (r.status() === 200) return;
    expect(r.status(), 'only the rate limit may delay sign-in').toBe(429);
    const wait = Number(r.headers()['x-retry-after'] ?? r.headers()['retry-after'] ?? '60');
    test.info().annotations.push({ type: 'rate-limit-wait-s', description: String(wait) });
    await new Promise((res) => setTimeout(res, (Math.min(wait, 70) + 2) * 1000));
  }
  throw new Error('could not sign in after waiting for the rate-limit window');
}

async function upload(role: string, filename: string, bytes: Buffer, contentType: string, opts: { sha256?: string } = {}) {
  const slotRes = await api.post('/api/assets/uploads', { headers: json, data: { role, filename, contentType, sizeBytes: bytes.length, sha256: opts.sha256 ?? sha(bytes) } });
  expect(slotRes.status(), await slotRes.text()).toBe(201);
  const slot = CreateUploadResponse.parse(await slotRes.json());
  created.assets.add(slot.asset.id);
  expect(slot.upload).toMatchObject({ strategy: 'worker-stream', method: 'PUT' });
  const t0 = Date.now();
  const put = await api.fetch(slot.upload.url, { method: 'PUT', headers: { ...slot.upload.headers, origin: BASE }, data: bytes, timeout: 120_000 });
  return { slot, put, ms: Date.now() - t0 };
}

test.beforeAll(async () => {
  if (!BASE || !EMAIL || !PASSWORD) throw new Error('REMOTE_BASE_URL / REMOTE_TEST_EMAIL / REMOTE_TEST_PASSWORD missing');
});

test('REMOTE-CONTENT-SIGNIN: one session for the content checks (waits out the auth suite’s rate limit)', async () => {
  test.setTimeout(240_000);
  api = await pwRequest.newContext({ baseURL: BASE });
  await signInWhenAllowed(api);
  const list = AssetListResponse.parse(await (await api.get('/api/assets')).json());
  expect(list.assets).toEqual([]);
  expect(list.usage).toEqual({ bytes: 0, quotaBytes: 1024 * 1024 * 1024 });
});

test('REMOTE-UPLOAD: tracking PNG streams through the Worker into R2 and reads back byte-identical via a cookieless signed URL', async () => {
  const { slot, put, ms } = await upload('tracking-image', 'poster.png', tracking, 'image/png');
  test.info().annotations.push({ type: 'put-ms', description: String(ms) });
  expect(put.status(), await put.text()).toBe(200);
  const a = AssetSummary.parse(await put.json());
  expect(a).toMatchObject({ id: slot.asset.id, state: 'validated', sizeBytes: tracking.length, sha256: sha(tracking), image: { width: 1200, height: 800 } });
  expect(new URL(a.contentUrl!).origin).toBe(BASE);

  const anon = await pwRequest.newContext(); // no cookies, like Scene Viewer / Quick Look
  const read = await anon.get(a.contentUrl!);
  expect(read.status()).toBe(200);
  expect(read.headers()['content-type']).toBe('image/png');
  expect(read.headers()['cache-control']).toMatch(/^private, max-age=\d+$/);
  expect(read.headers()['x-content-type-options']).toBe('nosniff');
  expect(sha(await read.body())).toBe(sha(tracking));

  // Range requests are not implemented yet (TASKS follow-up): record what the edge returns today.
  const ranged = await anon.get(a.contentUrl!, { headers: { range: 'bytes=0-99' } });
  test.info().annotations.push({ type: 'range-status', description: `${ranged.status()} ${ranged.headers()['content-length']} bytes` });

  // Signature tampering, missing signature, and a stale expiry are refused; unknown ids are 404.
  const u = new URL(a.contentUrl!);
  const sig = u.searchParams.get('sig')!;
  u.searchParams.set('sig', (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1));
  expect((await anon.get(u.href)).status()).toBe(403);
  expect((await anon.get(`${BASE}/api/assets/${a.id}/content`)).status()).toBe(403);
  u.searchParams.set('sig', sig);
  u.searchParams.set('exp', '1000');
  expect((await anon.get(u.href)).status()).toBe(403);
  expect((await anon.get(`${BASE}/api/assets/00000000-0000-4000-8000-000000000000/content${new URL(a.contentUrl!).search}`)).status()).toBe(404);

  // A slot is single-use.
  const again = await api.fetch(slot.upload.url, { method: 'PUT', headers: { ...slot.upload.headers, origin: BASE }, data: tracking });
  expect(again.status()).toBe(409);
  expect(ApiError.parse(await again.json()).error.reason).toBe('upload_not_pending');
  await anon.dispose();
});

test('REMOTE-UPLOAD-LARGE: ~10.8 MB display image streams, hashes and stores within Workers limits', async () => {
  test.setTimeout(180_000);
  const big = noisePng();
  expect(big.length).toBeGreaterThan(10 * 1024 * 1024);
  const { put, ms } = await upload('display-image', 'noise.png', big, 'image/png');
  test.info().annotations.push({ type: 'large-put', description: `${big.length} bytes in ${ms} ms` });
  expect(put.status(), await put.text()).toBe(200);
  const a = AssetSummary.parse(await put.json());
  expect(a).toMatchObject({ state: 'validated', sizeBytes: big.length, sha256: sha(big), image: { width: 1900, height: 1900 } });
  const read = await (await pwRequest.newContext()).get(a.contentUrl!, { timeout: 120_000 });
  expect(read.status()).toBe(200);
  expect(sha(await read.body())).toBe(sha(big));
});

test('REMOTE-UPLOAD-GLB: self-contained GLB is accepted with metadata', async () => {
  const model = glb();
  const { put } = await upload('model', 'chair.glb', model, 'model/gltf-binary');
  expect(put.status(), await put.text()).toBe(200);
  expect(AssetSummary.parse(await put.json())).toMatchObject({ state: 'validated', mimeType: 'model/gltf-binary', model: { gltfVersion: '2.0', meshes: 1 } });
});

test('REMOTE-CONVERT: Workflow + Cloudflare Container turn a display PNG into a matching GLB + USDZ (Phase 2, ADR-023)', async () => {
  test.setTimeout(360_000); // includes a possible container cold start
  const ring = readFileSync('tests/fixtures/images/ring_inner_hole.png');
  const { put } = await upload('display-image', 'ring.png', ring, 'image/png');
  expect(put.status(), await put.text()).toBe(200);
  const a = AssetSummary.parse(await put.json());
  const t0 = Date.now();
  const startRes = await api.post(`/api/assets/${a.id}/image-objects`, { headers: json, data: { settings: { widthMeters: 0.4, shapeMode: 'flat', alphaMode: 'auto' } } });
  expect(startRes.status(), await startRes.text()).toBe(202);
  let conv = ConversionSummary.parse(await startRes.json());
  while (conv.state === 'queued' || conv.state === 'running') {
    expect(Date.now() - t0, 'conversion did not finish in 5 minutes').toBeLessThan(300_000);
    await new Promise((r) => setTimeout(r, 2000));
    conv = ConversionSummary.parse(await (await api.get(`/api/conversions/${conv.id}`)).json());
  }
  test.info().annotations.push({ type: 'convert-ms', description: String(Date.now() - t0) });
  expect(conv.state, JSON.stringify(conv.error)).toBe('succeeded');
  expect(conv).toMatchObject({ resolvedAlphaMode: 'MASK', widthMeters: 0.4, heightMeters: 0.4 });
  const anon = await pwRequest.newContext();
  for (const [out, type, magic] of [
    [conv.outputs.glb!, 'model/gltf-binary', 'glTF'],
    [conv.outputs.usdz!, 'model/vnd.usdz+zip', 'PK'],
  ] as const) {
    const r = await anon.get(out.contentUrl!);
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toBe(type);
    const body = await r.body();
    expect(sha(body)).toBe(out.sha256);
    expect(body.subarray(0, magic.length).toString('latin1')).toBe(magic);
  }
  await anon.dispose();
});

test('REMOTE-CONVERT-WEBP: a WebP with soft alpha is prepared as PNG by the Container (Pillow) and converted (ADR-025)', async () => {
  test.setTimeout(360_000);
  const disc = readFileSync('tests/fixtures/normalize/disc_soft_alpha.webp');
  const { put } = await upload('display-image', 'disc.webp', disc, 'image/webp');
  expect(put.status(), await put.text()).toBe(200);
  const a = AssetSummary.parse(await put.json());
  const t0 = Date.now();
  const startRes = await api.post(`/api/assets/${a.id}/image-objects`, { headers: json, data: { settings: { widthMeters: 0.3, shapeMode: 'flat', alphaMode: 'auto' } } });
  expect(startRes.status(), await startRes.text()).toBe(202);
  let conv = ConversionSummary.parse(await startRes.json());
  while (conv.state === 'queued' || conv.state === 'running') {
    expect(Date.now() - t0, 'conversion did not finish in 5 minutes').toBeLessThan(300_000);
    await new Promise((r) => setTimeout(r, 2000));
    conv = ConversionSummary.parse(await (await api.get(`/api/conversions/${conv.id}`)).json());
  }
  test.info().annotations.push({ type: 'convert-webp-ms', description: String(Date.now() - t0) });
  expect(conv.state, JSON.stringify(conv.error)).toBe('succeeded');
  expect(conv).toMatchObject({ resolvedAlphaMode: 'BLEND', texture: { mimeType: 'image/png', width: 400, height: 400, changes: ['converted'] } });
  const anon = await pwRequest.newContext();
  const usdz = await anon.get(conv.outputs.usdz!.contentUrl!);
  expect(usdz.status()).toBe(200);
  expect(sha(await usdz.body())).toBe(conv.outputs.usdz!.sha256);
  await anon.dispose();
});

test('REMOTE-REJECT: disguised, mismatched and tampered uploads are refused and leave nothing readable', async () => {
  const html = Buffer.from('<!doctype html><script>alert(1)</script>'.padEnd(400, ' '));
  const disguised = await upload('display-image', 'cat.png', html, 'image/png');
  expect(disguised.put.status()).toBe(422);
  expect(ApiError.parse(await disguised.put.json()).error).toMatchObject({ code: 'invalid_file', reason: 'signature_mismatch' });
  const view = AssetSummary.parse(await (await api.get(`/api/assets/${disguised.slot.asset.id}`)).json());
  expect(view).toMatchObject({ state: 'rejected', rejectionCode: 'signature_mismatch', contentUrl: null });

  const wrongSum = await upload('tracking-image', 'poster.png', tracking, 'image/png', { sha256: '0'.repeat(64) });
  expect(wrongSum.put.status()).toBe(422);
  expect(ApiError.parse(await wrongSum.put.json()).error.reason).toBe('checksum_mismatch');

  // Cross-origin binary PUT is refused before reaching storage.
  const slotRes = await api.post('/api/assets/uploads', { headers: json, data: { role: 'model', filename: 'x.glb', contentType: 'model/gltf-binary', sizeBytes: glb().length } });
  const slot = CreateUploadResponse.parse(await slotRes.json());
  created.assets.add(slot.asset.id);
  const cross = await api.fetch(slot.upload.url, { method: 'PUT', headers: { ...slot.upload.headers, origin: 'https://evil.example' }, data: glb() });
  expect(cross.status()).toBe(403);
});

test('REMOTE-EXPERIENCE: drafts reference owned, validated assets; in-use assets cannot be deleted', async () => {
  const list = AssetListResponse.parse(await (await api.get('/api/assets')).json());
  const poster = list.assets.find((a) => a.filename === 'poster.png' && a.state === 'validated')!;
  const noise = list.assets.find((a) => a.filename === 'noise.png')!;
  // Usage = originals + generated outputs (the converted ring's GLB + USDZ count too, ADR-023).
  const originals = list.assets.filter((a) => a.state === 'validated').reduce((n, a) => n + (a.sizeBytes ?? 0), 0);
  expect(list.usage.bytes).toBeGreaterThan(originals);

  const cr = await api.post('/api/experiences', { headers: json, data: { name: 'Remote poster', placementMode: 'image' } });
  expect(cr.status()).toBe(201);
  const e = ExperienceDetail.parse(await cr.json());
  created.experiences.add(e.id);
  const save = (assetId: string | null, draftVersion: number) =>
    api.put(`/api/experiences/${e.id}/draft`, { headers: json, data: { draftVersion, scene: { ...e.draft.scene, placement: { ...e.draft.scene.placement, trackingTargetAssetId: assetId } } } });

  const wrongRole = await save(noise.id, e.draftVersion);
  expect(wrongRole.status()).toBe(400);
  expect(JSON.stringify(await wrongRole.json())).toContain('not a tracking image');

  const ok = await save(poster.id, e.draftVersion);
  expect(ok.status(), await ok.text()).toBe(200);
  const saved = ExperienceDetail.parse(await ok.json());
  expect(saved.draft.scene.placement).toMatchObject({ trackingTargetAssetId: poster.id });
  expect((await save(poster.id, e.draftVersion)).status()).toBe(409); // stale draftVersion

  const blocked = await api.delete(`/api/assets/${poster.id}`, { headers: { origin: BASE } });
  expect(blocked.status()).toBe(409);
  expect(ApiError.parse(await blocked.json()).error.reason).toBe('asset_in_use');
});

test('REMOTE-BROWSER-LIBRARY: real browser over HTTPS renders private previews from signed URLs', async ({ browser }) => {
  const context = await browser.newContext({ storageState: await api.storageState() });
  const page = await context.newPage();
  await page.goto('/library');
  await expect(page.getByRole('heading', { name: 'Asset library' })).toBeVisible();
  await expect(page.getByTestId('asset-card').filter({ hasText: 'poster.png' })).toContainText('1200 × 800 px');
  const imgs = page.locator('[data-testid="asset-card"] img');
  await expect
    .poll(() => imgs.evaluateAll((els) => (els as HTMLImageElement[]).filter((i) => i.complete && i.naturalWidth > 0).length), { timeout: 30_000 })
    .toBe(4); // poster + noise + ring + disc.webp; the GLB has a text tile
  await context.close();
});

test('REMOTE-VIEW-IN-AR: on HTTPS the page hands the signed files to Quick Look (iPhone) and Scene Viewer (Android, floor) (ADR-026)', async ({ browser }) => {
  const ring = AssetListResponse.parse(await (await api.get('/api/assets')).json()).assets.find((a) => a.filename === 'ring.png')!;
  const anon = await pwRequest.newContext();
  const phones = {
    ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1',
    android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36',
  };
  for (const os of ['ios', 'android'] as const) {
    const context = await browser.newContext({ storageState: await api.storageState(), userAgent: phones[os], viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    // The test browser has no Quick Look; pretend rel="ar" is supported, as in Safari.
    if (os === 'ios') await page.addInitScript(() => { const s = DOMTokenList.prototype.supports; DOMTokenList.prototype.supports = function (t: string) { return t === 'ar' || s.call(this, t); }; });
    await page.goto(`/library/${ring.id}/ar-object`); // opened on the phone: the newest version is shown
    const btn = page.getByRole('link', { name: 'View in AR' });
    await expect(btn).toBeVisible({ timeout: 20_000 });
    const href = (await btn.getAttribute('href'))!;
    let file: string;
    if (os === 'ios') {
      await expect(btn).toHaveAttribute('rel', 'ar');
      file = href;
    } else {
      const { query, extras } = parseSceneViewerIntent(href);
      expect(query).toMatchObject({ mode: 'ar_preferred', title: 'ring.png' });
      expect(query.enable_vertical_placement).toBeUndefined();
      expect(extras).toMatchObject({ package: 'com.google.android.googlequicksearchbox', 'S.browser_fallback_url': `${BASE}/library/${ring.id}/ar-object?ar=unavailable` });
      file = query.file!;
    }
    // What the native viewer will fetch: HTTPS, cookieless, the right type.
    expect(file.startsWith('https://')).toBe(true);
    const r = await anon.get(file);
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toBe(os === 'ios' ? 'model/vnd.usdz+zip' : 'model/gltf-binary');
    await context.close();
  }
  await anon.dispose();
});

test('REMOTE-BUILD: a draft compiles through the Workflow and the Container into a GLB + USDZ; the signed test link works without a session (Phase 5, ADR-034)', async () => {
  test.setTimeout(420_000); // includes a possible container cold start
  const cr = await api.post('/api/experiences', { headers: json, data: { name: 'Remote build', placementMode: 'floor' } });
  expect(cr.status()).toBe(201);
  const e = ExperienceDetail.parse(await cr.json());
  created.experiences.add(e.id);
  const t = { position: [0, 0.1, 0], rotation: [0, 0, 0, 1], scale: [0.2, 0.2, 0.2] };
  const scene = {
    ...e.draft.scene,
    nodes: [
      { id: 'box', kind: 'primitive', shape: 'box', color: '#215cc5', transform: t, visible: true, locked: false },
      { id: 'hello', kind: 'text', text: 'Hello AR', style: { color: '#17202a', sizeMeters: 0.05 }, transform: { ...t, position: [0, 0.3, 0], scale: [1, 1, 1] }, visible: true, locked: false },
    ],
    actions: [{ id: 'shop', type: 'open-url', url: 'https://example.com/shop', label: 'Shop now' }],
    primaryActionId: 'shop',
  };
  expect((await api.put(`/api/experiences/${e.id}/draft`, { headers: json, data: { draftVersion: e.draftVersion, scene } })).status()).toBe(200);
  const t0 = Date.now();
  expect((await api.post(`/api/experiences/${e.id}/builds`, { headers: json, data: {} })).status()).toBe(202);
  let b = BuildSummary.parse(await (await api.get(`/api/experiences/${e.id}/builds/latest`)).json());
  while (b.state === 'queued' || b.state === 'compiling') {
    expect(Date.now() - t0, 'build did not finish in 6 minutes').toBeLessThan(360_000);
    await new Promise((r) => setTimeout(r, 3000));
    b = BuildSummary.parse(await (await api.get(`/api/experiences/${e.id}/builds/latest`)).json());
  }
  test.info().annotations.push({ type: 'build-ms', description: String(Date.now() - t0) });
  expect(b, JSON.stringify(b)).toMatchObject({ state: 'ready', current: true });
  const anon = await pwRequest.newContext();
  const u = new URL(b.testUrl!);
  expect(u.origin).toBe(new URL(BASE).origin);
  const page = await anon.get(`${BASE}/api/test-builds/${u.pathname.split('/').pop()}${u.search}`);
  expect(page.status()).toBe(200);
  const tb = TestBuildResponse.parse(await page.json());
  expect(tb).toMatchObject({ name: 'Remote build', placementMode: 'floor', primary: { label: 'Shop now', url: 'https://example.com/shop' } });
  for (const [url, type, magic, expected] of [
    [tb.glbUrl!, 'model/gltf-binary', 'glTF', b.outputs.find((o) => o.platform === 'android')!.sha256],
    [tb.usdzUrl!, 'model/vnd.usdz+zip', 'PK', b.outputs.find((o) => o.platform === 'ios')!.sha256],
  ] as const) {
    const r = await anon.get(url);
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toBe(type);
    expect(r.headers()['cross-origin-resource-policy']).toBe('cross-origin');
    const body = await r.body();
    expect(body.subarray(0, magic.length).toString('latin1')).toBe(magic);
    expect(sha(body)).toBe(expected);
  }
  // The SPA serves the test page route itself (no session needed).
  expect((await anon.get(b.testUrl!)).status()).toBe(200);
  await anon.dispose();
});

test('REMOTE-PUBLISH: the built draft publishes at its stable URL; a visitor without a session gets the live files; unpublish takes it down (Phase 6, ADR-036)', async () => {
  test.setTimeout(120_000);
  const list = (await (await api.get('/api/experiences')).json()) as { experiences: { id: string; name: string }[] };
  const e = list.experiences.find((x) => x.name === 'Remote build')!;
  const p = await api.post(`/api/experiences/${e.id}/publish`, { headers: json, data: {} });
  expect(p.status(), await p.text()).toBe(200); // the draft's build is already complete → promoted at once
  const st = PublicationStatus.parse(await p.json());
  expect(st).toMatchObject({ state: 'published', upToDate: true });
  expect(new URL(st.url).origin).toBe(new URL(BASE).origin);
  const anon = await pwRequest.newContext();
  const slug = new URL(st.url).pathname.split('/').pop();
  const page = await anon.get(`${BASE}/api/public/${slug}`);
  expect(page.status()).toBe(200);
  const v = TestBuildResponse.parse(await page.json());
  expect(v).toMatchObject({ mode: 'public', name: 'Remote build', linkExpiresAt: null, id: st.live!.buildId });
  expect((await anon.get(v.glbUrl!)).status()).toBe(200);
  expect((await anon.get(st.url)).status()).toBe(200); // the SPA serves /x/{slug}
  // Anonymous counts (ADR-037): a visitor's view is counted for the published experience.
  expect((await anon.post(`${BASE}/api/public/${slug}/events`, { headers: { 'content-type': 'application/json', origin: BASE }, data: { event: 'view', detail: 'desktop' } })).status()).toBe(204);
  const stats = (await (await api.get(`/api/experiences/${e.id}/analytics?days=1`)).json()) as { totals: { views: number } };
  expect(stats.totals.views).toBe(1);
  expect((await api.post(`/api/experiences/${e.id}/unpublish`, { headers: json, data: {} })).status()).toBe(200);
  expect((await anon.get(`${BASE}/api/public/${slug}`)).status()).toBe(404);
  await anon.dispose();
});

test('REMOTE-PUBLIC-RATE-LIMIT: public reads are limited per client IP at the edge (60/min) with Retry-After (Phase 6, ADR-038)', async () => {
  test.setTimeout(60_000);
  const anon = await pwRequest.newContext();
  const probe = `${BASE}/api/public/remote-rate-limit-probe`;
  const statuses: number[] = [];
  for (let i = 0; i < 61; i++) statuses.push((await anon.get(probe)).status());
  // Earlier checks may already have used part of this minute's budget: some 404s, then 429.
  expect(statuses.filter((x) => x !== 404 && x !== 429)).toEqual([]);
  expect(statuses.at(-1)).toBe(429);
  const r = await anon.get(probe);
  expect(r.status()).toBe(429);
  expect(Number(r.headers()['retry-after'])).toBeGreaterThan(0);
  await anon.dispose();
});

test('REMOTE-CLEANUP: deleting removes the R2 object and the row; nothing is left behind', async () => {
  const before = AssetListResponse.parse(await (await api.get('/api/assets')).json());
  const poster = before.assets.find((a) => a.filename === 'poster.png' && a.state === 'validated')!;
  for (const id of created.experiences) expect((await api.delete(`/api/experiences/${id}`, { headers: { origin: BASE } })).status()).toBe(204);
  created.experiences.clear();

  const anon = await pwRequest.newContext();
  for (const id of created.assets) {
    const r = await api.delete(`/api/assets/${id}`, { headers: { origin: BASE } });
    expect([204, 404], `delete ${id}`).toContain(r.status());
  }
  // The signed URL that worked earlier now finds nothing.
  expect((await anon.get(poster.contentUrl!)).status()).toBe(404);
  const after = AssetListResponse.parse(await (await api.get('/api/assets')).json());
  expect(after.assets).toEqual([]);
  expect(after.usage.bytes).toBe(0);
  created.assets.clear();
  await anon.dispose();
});

test.afterAll(async () => {
  // Best effort if a test failed midway: never leave objects in R2.
  if (!api) return;
  for (const id of created.experiences) await api.delete(`/api/experiences/${id}`, { headers: { origin: BASE } }).catch(() => undefined);
  const left = await api.get('/api/assets').then((r) => r.json()).catch(() => null);
  for (const a of (left?.assets ?? []) as { id: string }[]) await api.delete(`/api/assets/${a.id}`, { headers: { origin: BASE } }).catch(() => undefined);
  await api.dispose();
});

/**
 * Phase 5 M16: test builds and device test links (ADR-034), end to end through the API with the real converter image
 * (Docker) and the inline runner (the same steps as the Workflow).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, AssetSummary, BuildSummary, CreateUploadResponse, ExperienceDetail, TestBuildResponse, type UploadableRole } from '@ar-creator/contracts';
import { IDENTITY_TRANSFORM, type Action, type SceneNode } from '@ar-creator/schema';
import { createTempDatabase, migrateDatabase } from '../../../packages/db/test/helpers.ts';
import { cubeGlb } from '../../../tests/e2e/app/glb.ts';
import { sha256Hex } from './files.ts';
import { Jar, LOCAL_USD_URL, PASSWORD, linkIn, makeHarness, uniqueEmail, type Harness } from './harness.ts';

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

async function upload(jar: Jar, role: UploadableRole, bytes: Uint8Array, type: string, filename: string) {
  const s = await h.req('/api/assets/uploads', { body: { role, filename, contentType: type, sizeBytes: bytes.length }, jar });
  const slot = CreateUploadResponse.parse(await s.json());
  const r = await h.req(slot.upload.url, { method: 'PUT', raw: { bytes, type }, jar });
  expect(r.status, await r.clone().text()).toBe(200);
  return AssetSummary.parse(await r.json());
}

async function floorExperience(jar: Jar, nodes: SceneNode[], actions: Action[] = [], primaryActionId?: string) {
  const c = ExperienceDetail.parse(await (await h.req('/api/experiences', { body: { name: 'Build me', placementMode: 'floor' }, jar })).json());
  const r = await h.req(`/api/experiences/${c.id}/draft`, { method: 'PUT', body: { draftVersion: c.draftVersion, scene: { ...c.draft.scene, nodes, actions, ...(primaryActionId ? { primaryActionId } : {}) } }, jar });
  expect(r.status, await r.clone().text()).toBe(200);
  return ExperienceDetail.parse(await r.json());
}

const node = (id: string, extra: Record<string, unknown>): SceneNode => ({ id, transform: IDENTITY_TRANSFORM, visible: true, locked: false, ...extra }) as SceneNode;
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');
const anon = (url: string) => h.req(pathOf(url), { origin: null });
const build = async (jar: Jar, id: string) => {
  const r = await h.req(`/api/experiences/${id}/builds`, { body: {}, jar });
  return { status: r.status, body: (await r.json()) as unknown };
};
const latest = async (jar: Jar, id: string) => BuildSummary.parse(await (await h.req(`/api/experiences/${id}/builds/latest`, { jar })).json());
const testApiUrl = (testUrl: string) => {
  const u = new URL(testUrl);
  return `/api/test-builds/${u.pathname.split('/').pop()}${u.search}`;
};

beforeAll(async () => {
  const health = await fetch(`${LOCAL_USD_URL}/healthz`).catch(() => null);
  if (!health?.ok) throw new Error(`The local USD converter is not running at ${LOCAL_USD_URL}. Start it with: npm run usd:serve -- --detach`);
  temp = await createTempDatabase();
  await migrateDatabase(temp.url);
  h = makeHarness({ dbUrl: temp.url });
  alice = await signedIn();
  bob = await signedIn();
});
afterAll(async () => {
  await h?.conversions.idle();
  await temp?.drop();
});

describe('test builds (ADR-034)', () => {
  it('compiles the draft into a GLB and a USDZ; an unchanged draft reuses the build; the test link opens it without signing in', async () => {
    const model = await upload(alice, 'model', new Uint8Array(cubeGlb(0.3)), 'model/gltf-binary', 'cube.glb');
    const actions: Action[] = [
      { id: 'shop', type: 'open-url', url: 'https://example.com/shop', label: 'Shop now' },
      { id: 'mail', type: 'mailto', address: 'hello@example.com' },
      { id: 'call', type: 'tel', number: '+1 (555) 010-0000' },
    ];
    const e = await floorExperience(
      alice,
      [node('cube', { kind: 'model', assetId: model.id }), node('box', { kind: 'primitive', shape: 'box', transform: { ...IDENTITY_TRANSFORM, position: [0.4, 0.1, 0], scale: [0.2, 0.2, 0.2] } }), node('t', { kind: 'text', text: 'Hello', style: { color: '#000000', sizeMeters: 0.05 } })],
      actions,
      'shop',
    );
    const first = await build(alice, e.id);
    expect(first.status).toBe(202);
    await h.conversions.idle();
    const b = await latest(alice, e.id);
    expect(b).toMatchObject({ state: 'ready', placementMode: 'floor', current: true, error: null });
    expect(b.outputs.map((o) => [o.platform, o.runtime, o.format, o.state])).toEqual([
      ['android', 'android_scene_viewer_floor', 'glb', 'ready'],
      ['ios', 'ios_quicklook_floor', 'usdz', 'ready'],
    ]);
    expect(b.testUrl).toMatch(/\/test\/[0-9a-f-]{36}\?v=[0-9a-f]{16}&exp=\d+&sig=[A-Za-z0-9_-]{43}$/);

    // Unchanged draft → the same build, nothing recompiled.
    const again = await build(alice, e.id);
    expect(again.status).toBe(200);
    expect(BuildSummary.parse(again.body).id).toBe(b.id);

    // The public test page: no cookie, signed link.
    const page = await h.req(testApiUrl(b.testUrl!), { origin: null });
    expect(page.status).toBe(200);
    const t = TestBuildResponse.parse(await page.json());
    expect(t).toMatchObject({ name: 'Build me', placementMode: 'floor', tracking: null, unavailable: { ios: null, android: null }, primary: { label: 'Shop now', url: 'https://example.com/shop' } });
    // What the Android image viewer runs (ADR-035): every action with what it does.
    expect(t.xr).toEqual({
      actions: [
        { id: 'shop', type: 'link', label: 'Shop now', href: 'https://example.com/shop' },
        { id: 'mail', type: 'link', label: 'Send email', href: 'mailto:hello@example.com' },
        { id: 'call', type: 'link', label: 'Call', href: 'tel:+15550100000' },
      ],
      taps: {},
      hotspots: [],
      primaryActionId: 'shop',
    });
    expect(t.links).toEqual([
      { label: 'Shop now', href: 'https://example.com/shop', primary: true },
      { label: 'Send email', href: 'mailto:hello@example.com', primary: false },
      { label: 'Call', href: 'tel:+15550100000', primary: false },
    ]);
    // The files: cookieless, right types, readable cross-origin (native viewers), checksums as recorded.
    const glb = await anon(t.glbUrl!);
    expect(glb.status).toBe(200);
    expect(glb.headers.get('content-type')).toBe('model/gltf-binary');
    expect(glb.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const glbBytes = new Uint8Array(await glb.arrayBuffer());
    expect(await sha256Hex(glbBytes)).toBe(b.outputs[0]!.sha256);
    expect(new TextDecoder().decode(glbBytes.subarray(0, 4))).toBe('glTF');
    const usdz = await anon(t.usdzUrl!);
    expect(usdz.headers.get('content-type')).toBe('model/vnd.usdz+zip');
    expect(new TextDecoder().decode(new Uint8Array(await usdz.arrayBuffer()).subarray(0, 2))).toBe('PK');

    // Tampered or foreign links are refused.
    expect((await h.req(testApiUrl(b.testUrl!).replace(/sig=[^&]+/, 'sig=' + 'A'.repeat(43)), { origin: null })).status).toBe(403);
    expect((await anon(t.glbUrl!.replace(/\/outputs\/[^/]+\//, `/outputs/${b.outputs[1]!.id}/`))).status).toBe(403);
    // Bob cannot build or read alice's experience.
    expect((await build(bob, e.id)).status).toBe(404);
    expect((await h.req(`/api/experiences/${e.id}/builds/latest`, { jar: bob })).status).toBe(404);
  });

  it('taps, hotspots and show/hide reach the viewer data', async () => {
    const e = await floorExperience(
      alice,
      [node('lamp', { kind: 'primitive', shape: 'sphere', actionId: 'tog' }), node('pin', { kind: 'hotspot', actionId: 'tog' })],
      [{ id: 'tog', type: 'toggle-visibility', nodeId: 'lamp' }],
    );
    await build(alice, e.id);
    await h.conversions.idle();
    const b = await latest(alice, e.id);
    const t = TestBuildResponse.parse(await (await h.req(testApiUrl(b.testUrl!), { origin: null })).json());
    expect(t.xr).toEqual({ actions: [{ id: 'tog', type: 'toggle-visibility', label: 'Show or hide', nodeId: 'lamp' }], taps: { lamp: 'tog', pin: 'tog' }, hotspots: ['pin'], primaryActionId: null });
    expect(t.links).toEqual([]);
  });

  it('a changed draft makes a new build and the older one is removed (link and files)', async () => {
    const e = await floorExperience(alice, [node('a', { kind: 'primitive', shape: 'sphere' })]);
    await build(alice, e.id);
    await h.conversions.idle();
    const old = await latest(alice, e.id);
    const oldPage = TestBuildResponse.parse(await (await h.req(testApiUrl(old.testUrl!), { origin: null })).json());

    const detail = ExperienceDetail.parse(await (await h.req(`/api/experiences/${e.id}`, { jar: alice })).json());
    await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { draftVersion: detail.draftVersion, scene: { ...detail.draft.scene, nodes: [...detail.draft.scene.nodes, node('b', { kind: 'primitive', shape: 'box' })] } }, jar: alice });
    expect((await latest(alice, e.id)).current).toBe(false);
    expect((await build(alice, e.id)).status).toBe(202);
    await h.conversions.idle();
    const next = await latest(alice, e.id);
    expect(next.id).not.toBe(old.id);
    expect(next).toMatchObject({ state: 'ready', current: true });
    expect(next.revisionNumber).toBeGreaterThan(old.revisionNumber);
    expect((await h.req(testApiUrl(old.testUrl!), { origin: null })).status).toBe(404);
    expect((await anon(oldPage.glbUrl!)).status).toBe(404);
  });

  it('a platform the compiler refuses is reported; the other still works (partially ready)', async () => {
    // A model that requires Draco: Android gets it as authored, iPhone cannot be made yet.
    const draco = new Uint8Array(cubeGlb(0.3));
    const json = JSON.parse(new TextDecoder().decode(draco.subarray(20, 20 + new DataView(draco.buffer).getUint32(12, true))).trim());
    json.extensionsUsed = ['KHR_draco_mesh_compression'];
    json.extensionsRequired = ['KHR_draco_mesh_compression'];
    let j = new TextEncoder().encode(JSON.stringify(json));
    j = Uint8Array.from([...j, ...new Array((4 - (j.length % 4)) % 4).fill(0x20)]);
    const binStart = 20 + new DataView(draco.buffer).getUint32(12, true);
    const rest = draco.subarray(binStart);
    const out = new Uint8Array(20 + j.length + rest.length);
    const dv = new DataView(out.buffer);
    out.set(draco.subarray(0, 12));
    dv.setUint32(8, out.length, true);
    dv.setUint32(12, j.length, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(j, 20);
    out.set(rest, 20 + j.length);
    const model = await upload(alice, 'model', out, 'model/gltf-binary', 'compressed.glb');
    const e = await floorExperience(alice, [node('m', { kind: 'model', assetId: model.id })]);
    await build(alice, e.id);
    await h.conversions.idle();
    const b = await latest(alice, e.id);
    expect(b.state).toBe('partially_ready');
    expect(b.outputs.find((o) => o.platform === 'android')!.state).toBe('ready');
    expect(b.outputs.find((o) => o.platform === 'ios')).toMatchObject({ state: 'failed', error: { code: 'unsupported_model' } });
    const t = TestBuildResponse.parse(await (await h.req(testApiUrl(b.testUrl!), { origin: null })).json());
    expect(t.usdzUrl).toBeNull();
    expect(t.glbUrl).not.toBeNull();
    expect(t.unavailable.ios).toMatch(/cannot be converted for iPhone yet/);
  });

  it('refuses drafts that are not ready, and builds do not keep assets from being deleted', async () => {
    const empty = await floorExperience(alice, []);
    const r = await h.req(`/api/experiences/${empty.id}/builds`, { body: {}, jar: alice });
    expect(r.status).toBe(409);
    expect(ApiError.parse(await r.json()).error.reason).toBe('not_ready');

    const model = await upload(alice, 'model', new Uint8Array(cubeGlb(0.2)), 'model/gltf-binary', 'temp.glb');
    const e = await floorExperience(alice, [node('m', { kind: 'model', assetId: model.id })]);
    await build(alice, e.id);
    await h.conversions.idle();
    expect((await latest(alice, e.id)).state).toBe('ready');
    // In the draft → in use.
    expect((await h.req(`/api/assets/${model.id}`, { method: 'DELETE', jar: alice })).status).toBe(409);
    // Removed from the draft → deletable, although a build still contains a copy of it.
    const d = ExperienceDetail.parse(await (await h.req(`/api/experiences/${e.id}`, { jar: alice })).json());
    await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { draftVersion: d.draftVersion, scene: { ...d.draft.scene, nodes: [node('s', { kind: 'primitive', shape: 'box' })] } }, jar: alice });
    expect((await h.req(`/api/assets/${model.id}`, { method: 'DELETE', jar: alice })).status).toBe(204);
    // Deleting the experience removes its build files.
    const b = await latest(alice, e.id);
    const t = TestBuildResponse.parse(await (await h.req(testApiUrl(b.testUrl!), { origin: null })).json());
    expect((await h.req(`/api/experiences/${e.id}`, { method: 'DELETE', jar: alice })).status).toBe(204);
    expect((await anon(t.glbUrl!)).status).toBe(404);
  });
});

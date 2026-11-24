/**
 * Phase 6 M18: publishing and the stable public URL (ADR-036) — including THE PHASE 6 GATE: editing and republishing
 * keeps the last-good URL and files live while a new version fails. Real converter image (Docker), inline runner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsSummary, ApiError, AssetSummary, CreateUploadResponse, ExperienceDetail, ExperienceListResponse, PublicationStatus, TestBuildResponse, type UploadableRole } from '@ar-creator/contracts';
import { IDENTITY_TRANSFORM, type SceneNode } from '@ar-creator/schema';
import { createTempDatabase, migrateDatabase } from '../../../packages/db/test/helpers.ts';
import { cubeGlb } from '../../../tests/e2e/app/glb.ts';
import { httpUsdConverter, UsdConverterUnavailable, type UsdConverter } from '../src/conversions/usd.ts';
import { sha256Hex } from './files.ts';
import { Jar, LOCAL_USD_URL, PASSWORD, linkIn, makeHarness, uniqueEmail, type Harness } from './harness.ts';

let temp: Awaited<ReturnType<typeof createTempDatabase>>;
let h: Harness;
let alice: Jar;

const real = httpUsdConverter((r) => fetch(r), LOCAL_USD_URL);
const control = { down: false };
const usd: UsdConverter = {
  imagePlane: (...a) => real.imagePlane(...a),
  prepareTexture: (...a) => real.prepareTexture(...a),
  async scene(...a) {
    if (control.down) throw new UsdConverterUnavailable('simulated outage');
    return real.scene(...a);
  },
};

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
  return AssetSummary.parse(await r.json());
}
const node = (id: string, extra: Record<string, unknown>): SceneNode => ({ id, transform: IDENTITY_TRANSFORM, visible: true, locked: false, ...extra }) as SceneNode;
async function setNodes(jar: Jar, id: string, nodes: SceneNode[]) {
  const d = ExperienceDetail.parse(await (await h.req(`/api/experiences/${id}`, { jar })).json());
  const r = await h.req(`/api/experiences/${id}/draft`, { method: 'PUT', body: { draftVersion: d.draftVersion, scene: { ...d.draft.scene, nodes } }, jar });
  expect(r.status, await r.clone().text()).toBe(200);
}
const status = async (jar: Jar, id: string) => PublicationStatus.parse(await (await h.req(`/api/experiences/${id}/publication`, { jar })).json());
const publish = async (jar: Jar, id: string) => {
  const r = await h.req(`/api/experiences/${id}/publish`, { body: {}, jar });
  return { status: r.status, body: (await r.json()) as unknown };
};
const slugOf = (url: string) => new URL(url).pathname.split('/').pop()!;
const publicPage = (slug: string) => h.req(`/api/public/${slug}`, { origin: null });
const anon = (url: string) => h.req(url.replace(/^https?:\/\/[^/]+/, ''), { origin: null });

/** A model that requires Draco: the GLB is made, the iPhone USDZ cannot be (partially ready). */
function dracoGlb(): Uint8Array {
  const g = new Uint8Array(cubeGlb(0.3));
  const jsonLen = new DataView(g.buffer).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(g.subarray(20, 20 + jsonLen)).trim());
  json.extensionsUsed = ['KHR_draco_mesh_compression'];
  json.extensionsRequired = ['KHR_draco_mesh_compression'];
  let j = new TextEncoder().encode(JSON.stringify(json));
  j = Uint8Array.from([...j, ...new Array((4 - (j.length % 4)) % 4).fill(0x20)]);
  const rest = g.subarray(20 + jsonLen);
  const out = new Uint8Array(20 + j.length + rest.length);
  const dv = new DataView(out.buffer);
  out.set(g.subarray(0, 12));
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  out.set(rest, 20 + j.length);
  return out;
}

beforeAll(async () => {
  const health = await fetch(`${LOCAL_USD_URL}/healthz`).catch(() => null);
  if (!health?.ok) throw new Error(`The local USD converter is not running at ${LOCAL_USD_URL}. Start it with: npm run usd:serve -- --detach`);
  temp = await createTempDatabase();
  await migrateDatabase(temp.url);
  h = makeHarness({ dbUrl: temp.url, usd });
  alice = await signedIn();
});
afterAll(async () => {
  await h?.conversions.idle();
  await temp?.drop();
});

describe('publishing (ADR-036)', () => {
  it('publish → stable public page; unchanged → no-op; changes → new version at the same URL; THE GATE: failures never replace the live version; unpublish', async () => {
    const e = ExperienceDetail.parse(await (await h.req('/api/experiences', { body: { name: 'Shop window', description: 'Try it on your table.', placementMode: 'floor' }, jar: alice })).json());
    let s = await status(alice, e.id);
    expect(s).toMatchObject({ state: 'unpublished', live: null, upToDate: false });
    expect(s.url).toMatch(new RegExp(`/x/${e.slug}$`));
    expect((await publicPage(e.slug)).status).toBe(404);
    // Not publishable while not ready (empty scene).
    const notReady = await h.req(`/api/experiences/${e.id}/publish`, { body: {}, jar: alice });
    expect(notReady.status).toBe(409);
    expect(ApiError.parse(await notReady.json()).error.reason).toBe('not_ready');

    // v1: published via a build made for the publish.
    await setNodes(alice, e.id, [node('box', { kind: 'primitive', shape: 'box' })]);
    expect((await publish(alice, e.id)).status).toBe(202);
    await h.conversions.idle();
    s = await status(alice, e.id);
    expect(s).toMatchObject({ state: 'published', upToDate: true, lastFailure: null, pending: null });
    const v1 = s.live!;
    const page1 = TestBuildResponse.parse(await (await publicPage(e.slug)).json());
    expect(page1).toMatchObject({ id: v1.buildId, mode: 'public', name: 'Shop window', description: 'Try it on your table.', linkExpiresAt: null, placementMode: 'floor' });
    expect((await anon(page1.glbUrl!)).status).toBe(200);
    expect(ExperienceListResponse.parse(await (await h.req('/api/experiences', { jar: alice })).json()).experiences.find((x) => x.id === e.id)).toMatchObject({ published: true, visibility: 'public' });
    // Unchanged → nothing to do.
    const again = await publish(alice, e.id);
    expect(again.status).toBe(200);
    expect(PublicationStatus.parse(again.body).live!.buildId).toBe(v1.buildId);

    // v2: a change, published at the SAME URL.
    await setNodes(alice, e.id, [node('box', { kind: 'primitive', shape: 'box' }), node('ball', { kind: 'primitive', shape: 'sphere' })]);
    expect((await status(alice, e.id)).upToDate).toBe(false);
    expect((await publish(alice, e.id)).status).toBe(202);
    await h.conversions.idle();
    s = await status(alice, e.id);
    const v2 = s.live!;
    expect(v2.buildId).not.toBe(v1.buildId);
    expect(v2.revisionNumber).toBeGreaterThan(v1.revisionNumber);
    const page2 = TestBuildResponse.parse(await (await publicPage(e.slug)).json());
    expect(page2.id).toBe(v2.buildId);
    const v2Glb = await sha256Hex(new Uint8Array(await (await anon(page2.glbUrl!)).arrayBuffer()));

    // GATE (a): the next version is only partly buildable (iPhone file fails) → not published; v2 stays live, unchanged.
    const draco = await upload(alice, 'model', dracoGlb(), 'model/gltf-binary', 'compressed.glb');
    await setNodes(alice, e.id, [node('box', { kind: 'primitive', shape: 'box' }), node('m', { kind: 'model', assetId: draco.id })]);
    expect((await publish(alice, e.id)).status).toBe(202);
    await h.conversions.idle();
    s = await status(alice, e.id);
    expect(s).toMatchObject({ state: 'published', upToDate: false, live: { buildId: v2.buildId } });
    expect(s.lastFailure!.message).toBe('Not published: the iPhone file could not be made. The live version is unchanged.');
    const after = TestBuildResponse.parse(await (await publicPage(e.slug)).json());
    expect(after.id).toBe(v2.buildId);
    expect(await sha256Hex(new Uint8Array(await (await anon(after.glbUrl!)).arrayBuffer()))).toBe(v2Glb);
    // Publishing that partial build directly is refused, with a reason.
    const partial = await h.req(`/api/experiences/${e.id}/publish`, { body: {}, jar: alice });
    expect(partial.status).toBe(409);

    // GATE (b): the compiler is down while publishing another change → the build fails; v2 still live.
    await setNodes(alice, e.id, [node('cyl', { kind: 'primitive', shape: 'cylinder' })]);
    control.down = true;
    expect((await publish(alice, e.id)).status).toBe(202);
    await h.conversions.idle();
    control.down = false;
    s = await status(alice, e.id);
    expect(s).toMatchObject({ state: 'published', live: { buildId: v2.buildId } });
    expect(s.lastFailure!.message).toMatch(/^Not published: .*The live version is unchanged\.$/);
    expect(TestBuildResponse.parse(await (await publicPage(e.slug)).json()).id).toBe(v2.buildId);
    // …and once the compiler is back, publishing the same draft succeeds.
    expect((await publish(alice, e.id)).status).toBe(202);
    await h.conversions.idle();
    s = await status(alice, e.id);
    expect(s).toMatchObject({ state: 'published', upToDate: true, lastFailure: null });
    expect(s.live!.buildId).not.toBe(v2.buildId);

    // Published files keep their assets in use; unpublishing takes the page down.
    expect((await h.req(`/api/assets/${draco.id}`, { method: 'DELETE', jar: alice })).status).toBe(204); // only in a failed build
    const un = await h.req(`/api/experiences/${e.id}/unpublish`, { body: {}, jar: alice });
    expect(PublicationStatus.parse(await un.json())).toMatchObject({ state: 'unpublished', live: null });
    expect((await publicPage(e.slug)).status).toBe(404);
    expect(ExperienceListResponse.parse(await (await h.req('/api/experiences', { jar: alice })).json()).experiences.find((x) => x.id === e.id)).toMatchObject({ published: false, visibility: 'draft' });
  });

  it('a model in the published version cannot be deleted, even after it is removed from the draft', async () => {
    const m = await upload(alice, 'model', new Uint8Array(cubeGlb(0.2)), 'model/gltf-binary', 'live.glb');
    const e = ExperienceDetail.parse(await (await h.req('/api/experiences', { body: { name: 'Live model', placementMode: 'floor' }, jar: alice })).json());
    await setNodes(alice, e.id, [node('m', { kind: 'model', assetId: m.id })]);
    await publish(alice, e.id);
    await h.conversions.idle();
    expect((await status(alice, e.id)).state).toBe('published');
    await setNodes(alice, e.id, [node('b', { kind: 'primitive', shape: 'box' })]);
    const blocked = await h.req(`/api/assets/${m.id}`, { method: 'DELETE', jar: alice });
    expect(blocked.status).toBe(409);
    expect(ApiError.parse(await blocked.json()).error.reason).toBe('asset_in_use');
  });

  it('only the owner can publish; slugs of unpublished experiences reveal nothing', async () => {
    const bob = await signedIn();
    const e = ExperienceDetail.parse(await (await h.req('/api/experiences', { body: { name: 'Private', placementMode: 'floor' }, jar: alice })).json());
    expect((await h.req(`/api/experiences/${e.id}/publish`, { body: {}, jar: bob })).status).toBe(404);
    expect((await h.req(`/api/experiences/${e.id}/publication`, { jar: bob })).status).toBe(404);
    expect((await publicPage(e.slug)).status).toBe(404);
    expect((await publicPage('NOT A SLUG')).status).toBe(404);
    expect(slugOf(`https://x/x/${e.slug}`)).toBe(e.slug);
  });
});

describe('anonymous analytics (ADR-037)', () => {
  it('counts views, AR taps and link taps of a published experience per day; nothing for unpublished ones; owner-only summary', async () => {
    const e = ExperienceDetail.parse(await (await h.req('/api/experiences', { body: { name: 'Counted', placementMode: 'floor' }, jar: alice })).json());
    await setNodes(alice, e.id, [node('b', { kind: 'primitive', shape: 'box' })]);
    const ev = (body: unknown, origin?: string | null) => h.req(`/api/public/${e.slug}/events`, { body, ...(origin !== undefined ? { origin } : {}) });
    // Not published yet: accepted, not counted.
    expect((await ev({ event: 'view', detail: 'ios' })).status).toBe(204);
    await publish(alice, e.id);
    await h.conversions.idle();
    for (const body of [
      { event: 'view', detail: 'ios' },
      { event: 'view', detail: 'ios' },
      { event: 'view', detail: 'android' },
      { event: 'view', detail: 'desktop' },
      { event: 'ar_tap', detail: 'ios_quicklook_floor' },
      { event: 'ar_tap', detail: 'android_scene_viewer_floor' },
      { event: 'link_tap', detail: 'web' },
    ]) expect((await ev(body)).status).toBe(204);
    // Invalid events are refused; other sites cannot count (same-origin POST rule); unknown slugs look the same.
    expect((await ev({ event: 'view', detail: 'tv' })).status).toBe(400);
    expect((await ev({ event: 'purchase', detail: 'x' })).status).toBe(400);
    expect((await ev({ event: 'view', detail: 'ios' }, 'https://evil.example')).status).toBe(403);
    expect((await h.req('/api/public/no-such-experience/events', { body: { event: 'view', detail: 'ios' } })).status).toBe(204);

    const a = AnalyticsSummary.parse(await (await h.req(`/api/experiences/${e.id}/analytics?days=7`, { jar: alice })).json());
    expect(a).toMatchObject({ days: 7, totals: { views: 4, arTaps: 2, linkTaps: 1 }, views: { ios: 2, android: 1, desktop: 1 }, arTaps: { quickLook: 1, sceneViewer: 1, webxr: 0 } });
    expect(a.perDay).toEqual([{ day: new Date().toISOString().slice(0, 10), views: 4, arTaps: 2, linkTaps: 1 }]);
    const bob = await signedIn();
    expect((await h.req(`/api/experiences/${e.id}/analytics`, { jar: bob })).status).toBe(404);
    // Deleting the experience deletes its counts (cascade): nothing left to read.
    expect((await h.req(`/api/experiences/${e.id}`, { method: 'DELETE', jar: alice })).status).toBe(204);
  });
});

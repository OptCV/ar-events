/**
 * Milestone 4 — experience management API against local Docker Postgres (fresh migrated DB per file).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, ExperienceDetail, ExperienceListResponse, ReadinessResponse } from '@ar-creator/contracts';
import { IDENTITY_TRANSFORM, type DraftExperienceScene } from '@ar-creator/schema';
import { createTempDatabase, migrateDatabase } from '../../../packages/db/test/helpers.ts';
import { makeSlug } from '../src/experiences/routes.ts';
import { Jar, PASSWORD, linkIn, makeHarness, uniqueEmail, type Harness } from './harness.ts';

let temp: Awaited<ReturnType<typeof createTempDatabase>>;
let h: Harness;
let alice: Jar;
let bob: Jar;

async function signedIn(): Promise<Jar> {
  const email = uniqueEmail();
  const before = h.mails.length;
  await h.req('/api/auth/sign-up/email', { body: { name: 'Creator', email, password: PASSWORD, callbackURL: '/email-verified' } });
  const mail = h.mails.slice(before).find((m) => m.to === email);
  await h.req(linkIn(mail).replace(/^https?:\/\/[^/]+/, ''));
  const jar = new Jar();
  const r = await h.req('/api/auth/sign-in/email', { body: { email, password: PASSWORD }, jar });
  expect(r.status).toBe(200);
  return jar;
}

async function create(jar: Jar, body: Record<string, unknown> = { name: 'Poster launch', placementMode: 'floor' }) {
  const r = await h.req('/api/experiences', { body, jar });
  return { r, e: r.status === 201 ? ExperienceDetail.parse(await r.json()) : null };
}

const node = (id: string) => ({ id, kind: 'primitive', shape: 'box', transform: IDENTITY_TRANSFORM, visible: true, locked: false });

beforeAll(async () => {
  temp = await createTempDatabase();
  await migrateDatabase(temp.url);
  h = makeHarness({ dbUrl: temp.url });
  alice = await signedIn();
  bob = await signedIn();
});
afterAll(async () => temp?.drop());

describe('authentication and CSRF', () => {
  it('every experience route requires a session (401)', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, path, body] of [
      ['GET', '/api/experiences', undefined],
      ['POST', '/api/experiences', { name: 'x', placementMode: 'floor' }],
      ['GET', `/api/experiences/${id}`, undefined],
      ['PATCH', `/api/experiences/${id}`, { name: 'x' }],
      ['PUT', `/api/experiences/${id}/draft`, {}],
      ['POST', `/api/experiences/${id}/validate`, {}],
      ['DELETE', `/api/experiences/${id}`, undefined],
    ] as const) {
      const r = await h.req(path, { method, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it('cross-origin and non-JSON mutations are refused (403)', async () => {
    expect((await h.req('/api/experiences', { body: { name: 'x', placementMode: 'floor' }, jar: alice, origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.req('/api/experiences', { method: 'POST', jar: alice, headers: { 'content-type': 'text/plain' } })).status).toBe(403);
  });
});

describe('create, read, list, update, delete', () => {
  it('creates an experience with an initial draft revision for the chosen placement', async () => {
    for (const mode of ['image', 'floor', 'wall'] as const) {
      const { r, e } = await create(alice, { name: `Mode ${mode}`, description: 'Hello', placementMode: mode });
      expect(r.status).toBe(201);
      expect(e).toMatchObject({ placementMode: mode, visibility: 'draft', published: false, draftVersion: 1, description: 'Hello', draft: { revisionNumber: 1 } });
      expect(e!.draft.scene.placement.mode).toBe(mode);
      expect(e!.slug).toMatch(/^mode-[a-z]+-[a-z0-9]{6}$/);
    }
    const image = (await create(alice, { name: 'Img', placementMode: 'image' })).e!;
    expect(image.draft.scene.placement).toEqual({ mode: 'image', trackingTargetAssetId: null, physicalWidthMeters: 0.2 });
  });

  it('validates input (400 with field issues)', async () => {
    for (const body of [{ name: '', placementMode: 'floor' }, { name: 'x', placementMode: 'ceiling' }, { name: 'x'.repeat(121), placementMode: 'floor' }, {}]) {
      const r = await h.req('/api/experiences', { body, jar: alice });
      expect(r.status).toBe(400);
      const e = ApiError.parse(await r.json());
      expect(e.error.code).toBe('bad_request');
      expect(e.error.issues?.length).toBeGreaterThan(0);
    }
  });

  it('lists only the caller’s experiences, newest first', async () => {
    const a = (await create(alice, { name: 'Alpha', placementMode: 'floor' })).e!;
    const b = (await create(bob, { name: 'Bravo', placementMode: 'wall' })).e!;
    const listA = ExperienceListResponse.parse(await (await h.req('/api/experiences', { jar: alice })).json()).experiences;
    const listB = ExperienceListResponse.parse(await (await h.req('/api/experiences', { jar: bob })).json()).experiences;
    expect(listA.map((x) => x.id)).toContain(a.id);
    expect(listA.map((x) => x.id)).not.toContain(b.id);
    expect(listB.map((x) => x.id)).toEqual([b.id]);
    expect(listA[0]!.id).toBe(a.id);
  });

  it('PATCH updates metadata; public visibility is not allowed yet', async () => {
    const e = (await create(alice)).e!;
    const r = await h.req(`/api/experiences/${e.id}`, { method: 'PATCH', body: { name: 'Renamed', description: null, visibility: 'private_test' }, jar: alice });
    expect(r.status).toBe(200);
    expect(ExperienceDetail.parse(await r.json())).toMatchObject({ name: 'Renamed', description: null, visibility: 'private_test' });
    expect((await h.req(`/api/experiences/${e.id}`, { method: 'PATCH', body: { visibility: 'public' }, jar: alice })).status).toBe(400);
    expect((await h.req(`/api/experiences/${e.id}`, { method: 'PATCH', body: {}, jar: alice })).status).toBe(400);
  });

  it('DELETE removes the experience and its revisions', async () => {
    const e = (await create(alice)).e!;
    expect((await h.req(`/api/experiences/${e.id}`, { method: 'DELETE', jar: alice })).status).toBe(204);
    expect((await h.req(`/api/experiences/${e.id}`, { jar: alice })).status).toBe(404);
    const n = await h.sql('SELECT count(*)::int AS n FROM experience_revisions WHERE experience_id = $1', [e.id]);
    expect(n.rows[0]!.n).toBe(0);
  });

  it('malformed ids are 404, not errors', async () => {
    for (const id of ['not-a-uuid', "1' OR '1'='1", '00000000-0000-0000-0000-000000000000x']) {
      expect((await h.req(`/api/experiences/${encodeURIComponent(id)}`, { jar: alice })).status).toBe(404);
    }
  });
});

describe('ownership isolation (other users get 404 on every route)', () => {
  it('bob cannot read, update, save, validate or delete alice’s experience', async () => {
    const e = (await create(alice)).e!;
    const scene: DraftExperienceScene = { ...e.draft.scene, nodes: [node('hijack')] as DraftExperienceScene['nodes'] };
    const attempts = [
      await h.req(`/api/experiences/${e.id}`, { jar: bob }),
      await h.req(`/api/experiences/${e.id}`, { method: 'PATCH', body: { name: 'pwned' }, jar: bob }),
      await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { scene, draftVersion: 1 }, jar: bob }),
      await h.req(`/api/experiences/${e.id}/validate`, { body: {}, jar: bob }),
      await h.req(`/api/experiences/${e.id}`, { method: 'DELETE', jar: bob }),
    ];
    for (const r of attempts) {
      expect(r.status).toBe(404);
      expect(ApiError.parse(await r.json()).error.code).toBe('not_found');
    }
    const still = ExperienceDetail.parse(await (await h.req(`/api/experiences/${e.id}`, { jar: alice })).json());
    expect(still).toMatchObject({ name: 'Poster launch', draftVersion: 1 });
    expect(still.draft.scene.nodes).toEqual([]);
  });
});

describe('draft saving (scene configuration API)', () => {
  it('saves a valid scene and bumps draftVersion', async () => {
    const e = (await create(alice)).e!;
    const scene = { ...e.draft.scene, nodes: [node('box')], actions: [{ id: 'buy', type: 'open-url', url: 'https://shop.example.com' }], primaryActionId: 'buy' };
    const r = await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { scene, draftVersion: 1 }, jar: alice });
    expect(r.status).toBe(200);
    const saved = ExperienceDetail.parse(await r.json());
    expect(saved.draftVersion).toBe(2);
    expect(saved.draft.scene.nodes.map((n) => n.id)).toEqual(['box']);
    expect(saved.draft.scene.primaryActionId).toBe('buy');
  });

  it('rejects invalid scenes with field issues (hostile URL, cycles, unknown references)', async () => {
    const e = (await create(alice)).e!;
    for (const scene of [
      { ...e.draft.scene, actions: [{ id: 'x', type: 'open-url', url: 'javascript:alert(1)' }] },
      { ...e.draft.scene, nodes: [{ ...node('a'), parentId: 'b' }, { ...node('b'), parentId: 'a' }] },
      { ...e.draft.scene, primaryActionId: 'missing' },
      { ...e.draft.scene, schemaVersion: 99 },
    ]) {
      const r = await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { scene, draftVersion: 1 }, jar: alice });
      expect(r.status).toBe(400);
      expect(ApiError.parse(await r.json()).error.issues?.length).toBeGreaterThan(0);
    }
  });

  it('stale draftVersion → 409 stale_draft with the current version; nothing overwritten', async () => {
    const e = (await create(alice)).e!;
    const s1 = { ...e.draft.scene, nodes: [node('first')] };
    expect((await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { scene: s1, draftVersion: 1 }, jar: alice })).status).toBe(200);
    const s2 = { ...e.draft.scene, nodes: [node('stale')] };
    const r = await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { scene: s2, draftVersion: 1 }, jar: alice });
    expect(r.status).toBe(409);
    expect(ApiError.parse(await r.json()).error).toMatchObject({ code: 'conflict', reason: 'stale_draft', currentDraftVersion: 2 });
    const now = ExperienceDetail.parse(await (await h.req(`/api/experiences/${e.id}`, { jar: alice })).json());
    expect(now.draft.scene.nodes.map((n) => n.id)).toEqual(['first']);
  });

  it('concurrent saves with the same version: exactly one wins', async () => {
    const e = (await create(alice)).e!;
    const save = (id: string) => h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { scene: { ...e.draft.scene, nodes: [node(id)] }, draftVersion: 1 }, jar: alice });
    const results = await Promise.all([save('w1'), save('w2'), save('w3'), save('w4')]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    const now = ExperienceDetail.parse(await (await h.req(`/api/experiences/${e.id}`, { jar: alice })).json());
    expect(now.draftVersion).toBe(2);
  });

  it('placement change requires confirmation, keeps nodes, and updates the listed mode', async () => {
    const e = (await create(alice, { name: 'Switch', placementMode: 'floor' })).e!;
    const withNode = { ...e.draft.scene, nodes: [node('keep')] };
    const v2 = ExperienceDetail.parse(await (await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { scene: withNode, draftVersion: 1 }, jar: alice })).json());
    const wall = { ...v2.draft.scene, placement: { mode: 'wall' } };
    const unconfirmed = await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { scene: wall, draftVersion: 2 }, jar: alice });
    expect(unconfirmed.status).toBe(409);
    expect(ApiError.parse(await unconfirmed.json()).error.reason).toBe('placement_change_unconfirmed');
    const ok = await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { scene: wall, draftVersion: 2, confirmPlacementChange: true }, jar: alice });
    expect(ok.status).toBe(200);
    const after = ExperienceDetail.parse(await ok.json());
    expect(after).toMatchObject({ placementMode: 'wall', draftVersion: 3 });
    expect(after.draft.scene.nodes.map((n) => n.id)).toEqual(['keep']);
    const listed = ExperienceListResponse.parse(await (await h.req('/api/experiences', { jar: alice })).json()).experiences.find((x) => x.id === e.id);
    expect(listed?.placementMode).toBe('wall');
  });

  it('bodies over 256 KB are refused (413)', async () => {
    const e = (await create(alice)).e!;
    const huge = { ...e.draft.scene, nodes: [{ ...node('big'), name: 'x'.repeat(120) }], padding: 'x'.repeat(300 * 1024) };
    const r = await h.req(`/api/experiences/${e.id}/draft`, { method: 'PUT', body: { scene: huge, draftVersion: 1 }, jar: alice });
    expect(r.status).toBe(413);
    expect(ApiError.parse(await r.json()).error.code).toBe('payload_too_large');
  });
});

describe('publish readiness', () => {
  it('reports blocking issues for an empty image draft and readiness for a populated floor draft', async () => {
    const img = (await create(alice, { name: 'Img', placementMode: 'image' })).e!;
    const r1 = ReadinessResponse.parse(await (await h.req(`/api/experiences/${img.id}/validate`, { body: {}, jar: alice })).json());
    expect(r1.ready).toBe(false);
    expect(r1.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['tracking_image_missing', 'scene_empty']));

    const floor = (await create(alice)).e!;
    await h.req(`/api/experiences/${floor.id}/draft`, { method: 'PUT', body: { scene: { ...floor.draft.scene, nodes: [node('a')] }, draftVersion: 1 }, jar: alice });
    const r2 = ReadinessResponse.parse(await (await h.req(`/api/experiences/${floor.id}/validate`, { body: {}, jar: alice })).json());
    expect(r2.ready).toBe(true);
  });
});

describe('slugs', () => {
  it('are URL-safe, length-bounded and unique-suffixed', () => {
    for (const name of ['Café Déjà Vu!', '   ', '🎉🎉', 'a'.repeat(200), 'Hello -- World']) {
      const s = makeSlug(name);
      expect(s).toMatch(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/);
    }
    expect(makeSlug('Café Déjà Vu!')).toMatch(/^cafe-deja-vu-[a-z0-9]{6}$/);
    expect(makeSlug('🎉')).toMatch(/^experience-[a-z0-9]{6}$/);
  });
});

describe('DELETE CSRF', () => {
  it('a cross-origin or origin-less DELETE is refused (403) and nothing is deleted', async () => {
    const e = (await create(alice)).e!;
    expect((await h.req(`/api/experiences/${e.id}`, { method: 'DELETE', jar: alice, origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.req(`/api/experiences/${e.id}`, { method: 'DELETE', jar: alice, origin: null })).status).toBe(403);
    expect((await h.req(`/api/experiences/${e.id}`, { jar: alice })).status).toBe(200);
  });
});

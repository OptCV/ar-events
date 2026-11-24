import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectDb, type DbHandle } from '../src/client.ts';
import { analyticsDaily, assetDerivatives, assets, experienceRevisions, experiences, generatedOutputs, processingJobs, user } from '../src/schema/index.ts';
import { createTempDatabase, migrateDatabase } from './helpers.ts';

let temp: Awaited<ReturnType<typeof createTempDatabase>>;
let h: DbHandle;
const sha = (c: string) => c.repeat(64);

beforeAll(async () => {
  temp = await createTempDatabase();
  await migrateDatabase(temp.url);
  h = await connectDb(temp.url);
});
afterAll(async () => {
  await h?.close();
  await temp?.drop();
});

/** Postgres error code of a rejected promise (drizzle wraps pg errors in `cause`). */
async function pgCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.code ?? err.cause?.code ?? 'no-code';
  }
  return 'resolved';
}
const UNIQUE = '23505';
const FK = '23503';
const CHECK = '23514';
const PENDING = { uploadExpiresAt: new Date(Date.now() + 15 * 60_000) };

async function makeUser(id = randomUUID()) {
  await h.db.insert(user).values({ id, name: 'Test', email: `${id}@example.com` });
  return id;
}
async function makeExperience(ownerId: string, slug = `exp-${randomUUID().slice(0, 8)}`) {
  const [e] = await h.db.insert(experiences).values({ ownerId, name: 'Poster', slug, placementMode: 'image' }).returning();
  return e!;
}
async function makeRevision(experienceId: string, n: number, state: 'draft' | 'snapshot' = 'draft') {
  const [r] = await h.db
    .insert(experienceRevisions)
    .values({ experienceId, revisionNumber: n, state, schemaVersion: 1, config: { schemaVersion: 1 }, frozenAt: state === 'draft' ? null : new Date() })
    .returning();
  return r!;
}

let owner: string;
beforeEach(async () => {
  owner = await makeUser();
});

describe('experiences', () => {
  it('enforce unique, well-formed slugs and non-blank names', async () => {
    await makeExperience(owner, 'poster-one');
    expect(await pgCode(makeExperience(owner, 'poster-one'))).toBe(UNIQUE);
    expect(await pgCode(makeExperience(owner, 'Bad_Slug!'))).toBe(CHECK);
    expect(await pgCode(makeExperience(owner, '-x-'))).toBe(CHECK);
    expect(await pgCode(h.db.insert(experiences).values({ ownerId: owner, name: '   ', slug: 'blank-name', placementMode: 'floor' }))).toBe(CHECK);
  });

  it('require an existing owner', async () => {
    expect(await pgCode(makeExperience('no-such-user'))).toBe(FK);
  });

  it('allow only one draft revision per experience', async () => {
    const e = await makeExperience(owner);
    await makeRevision(e.id, 1);
    expect(await pgCode(makeRevision(e.id, 2))).toBe(UNIQUE);
    await makeRevision(e.id, 3, 'snapshot'); // snapshots are fine
    expect(await pgCode(makeRevision(e.id, 3, 'snapshot'))).toBe(UNIQUE); // revision numbers unique per experience
  });

  it('can only point at revisions of the same experience (composite FK)', async () => {
    const a = await makeExperience(owner);
    const b = await makeExperience(owner);
    const revB = await makeRevision(b.id, 1);
    expect(await pgCode(h.db.update(experiences).set({ draftRevisionId: revB.id }).where(eq(experiences.id, a.id)))).toBe(FK);
    const revA = await makeRevision(a.id, 1);
    await h.db.update(experiences).set({ draftRevisionId: revA.id }).where(eq(experiences.id, a.id));
  });

  it('protect the published revision from deletion, but deleting the experience cascades', async () => {
    const e = await makeExperience(owner);
    const r = await makeRevision(e.id, 1, 'snapshot');
    await h.db.update(experiences).set({ publishedRevisionId: r.id }).where(eq(experiences.id, e.id));
    expect(await pgCode(h.db.delete(experienceRevisions).where(eq(experienceRevisions.id, r.id)))).toBe(FK);
    await h.db.delete(experiences).where(eq(experiences.id, e.id));
    expect(await h.db.select().from(experienceRevisions).where(eq(experienceRevisions.experienceId, e.id))).toEqual([]);
  });

  it('deleting a user cascades to their experiences and assets', async () => {
    const u = await makeUser();
    const e = await makeExperience(u);
    await h.db.insert(assets).values({ ...PENDING, ownerId: u, role: 'model', r2Key: `users/${u}/assets/${randomUUID()}/original` });
    await h.db.delete(user).where(eq(user.id, u));
    expect(await h.db.select().from(experiences).where(eq(experiences.id, e.id))).toEqual([]);
    expect(await h.db.select().from(assets).where(eq(assets.ownerId, u))).toEqual([]);
  });
});

describe('revision immutability (trigger)', () => {
  it('drafts are mutable', async () => {
    const e = await makeExperience(owner);
    const r = await makeRevision(e.id, 1);
    await h.db.update(experienceRevisions).set({ config: { schemaVersion: 1, changed: true } }).where(eq(experienceRevisions.id, r.id));
  });

  it('frozen revisions reject content changes and cannot return to draft', async () => {
    const e = await makeExperience(owner);
    const r = await makeRevision(e.id, 1, 'snapshot');
    expect(await pgCode(h.db.update(experienceRevisions).set({ config: { tampered: true } }).where(eq(experienceRevisions.id, r.id)))).toBe(CHECK);
    expect(await pgCode(h.db.update(experienceRevisions).set({ schemaVersion: 2 }).where(eq(experienceRevisions.id, r.id)))).toBe(CHECK);
    expect(await pgCode(h.db.update(experienceRevisions).set({ state: 'draft', frozenAt: null }).where(eq(experienceRevisions.id, r.id)))).toBe(CHECK);
    // lifecycle transitions remain possible
    await h.db.update(experienceRevisions).set({ state: 'published', validationReport: { ok: true } }).where(eq(experienceRevisions.id, r.id));
  });

  it('builds (0006): content hash format, one build per experience × hash, immutable once frozen; ready state', async () => {
    const e = await makeExperience(owner);
    const [b] = await h.db
      .insert(experienceRevisions)
      .values({ experienceId: e.id, revisionNumber: 2, state: 'compiling', schemaVersion: 1, config: { schemaVersion: 1 }, frozenAt: new Date(), contentHash: sha('a') })
      .returning();
    expect(await pgCode(h.db.insert(experienceRevisions).values({ experienceId: e.id, revisionNumber: 3, state: 'snapshot', schemaVersion: 1, config: { schemaVersion: 1 }, frozenAt: new Date(), contentHash: sha('a') }))).toBe(UNIQUE);
    expect(await pgCode(h.db.insert(experienceRevisions).values({ experienceId: e.id, revisionNumber: 4, state: 'snapshot', schemaVersion: 1, config: { schemaVersion: 1 }, frozenAt: new Date(), contentHash: 'NOT-A-HASH' }))).toBe(CHECK);
    expect(await pgCode(h.db.update(experienceRevisions).set({ contentHash: sha('b') }).where(eq(experienceRevisions.id, b!.id)))).toBe(CHECK);
    await h.db.update(experienceRevisions).set({ state: 'ready' }).where(eq(experienceRevisions.id, b!.id));
  });

  it('frozen_at must be set exactly when the revision is not a draft', async () => {
    const e = await makeExperience(owner);
    expect(
      await pgCode(h.db.insert(experienceRevisions).values({ experienceId: e.id, revisionNumber: 1, state: 'snapshot', schemaVersion: 1, config: {} })),
    ).toBe(CHECK);
  });

  it('config must be a JSON object', async () => {
    const e = await makeExperience(owner);
    expect(await pgCode(h.db.insert(experienceRevisions).values({ experienceId: e.id, revisionNumber: 1, schemaVersion: 1, config: [1, 2] }))).toBe(CHECK);
  });
});

describe('assets, derivatives, outputs, jobs', () => {
  it('assets: owned R2 prefix, checksum format, uploaded requires checksum+size+mime', async () => {
    const key = () => `users/${owner}/assets/${randomUUID()}/original`;
    expect(await pgCode(h.db.insert(assets).values({ ...PENDING, ownerId: owner, role: 'display-image', r2Key: 'public/evil' }))).toBe(CHECK);
    expect(await pgCode(h.db.insert(assets).values({ ...PENDING, ownerId: owner, role: 'display-image', r2Key: key(), sha256: 'XYZ' }))).toBe(CHECK);
    expect(await pgCode(h.db.insert(assets).values({ ownerId: owner, role: 'display-image', r2Key: key(), state: 'uploaded' }))).toBe(CHECK);
    await h.db.insert(assets).values({ ownerId: owner, role: 'display-image', r2Key: key(), state: 'uploaded', sha256: sha('a'), sizeBytes: 10, mimeType: 'image/png' });
    expect(await pgCode(h.db.insert(assets).values({ ...PENDING, ownerId: owner, role: 'not-a-role' as never, r2Key: key() }))).toBe('22P02');
  });

  it('assets: a pending upload needs an expiry; a rejection needs a reason code', async () => {
    const key = () => `users/${owner}/assets/${randomUUID()}/original`;
    expect(await pgCode(h.db.insert(assets).values({ ownerId: owner, role: 'display-image', r2Key: key() }))).toBe(CHECK);
    expect(await pgCode(h.db.insert(assets).values({ ownerId: owner, role: 'display-image', r2Key: key(), state: 'rejected' }))).toBe(CHECK);
    await h.db.insert(assets).values({ ownerId: owner, role: 'display-image', r2Key: key(), state: 'rejected', rejectionCode: 'signature_mismatch' });
  });

  it('derivatives: provenance is unique and a ready derivative is immutable', async () => {
    const [a] = await h.db.insert(assets).values({ ...PENDING, ownerId: owner, role: 'display-image', r2Key: `users/${owner}/assets/${randomUUID()}/original` }).returning();
    const base = { sourceAssetId: a!.id, outputType: 'image_object_glb' as const, settings: { widthMeters: 0.5 }, settingsHash: sha('b'), converterVersion: 'image-to-ar@0.1.0' };
    const [d] = await h.db.insert(assetDerivatives).values(base).returning();
    expect(await pgCode(h.db.insert(assetDerivatives).values(base))).toBe(UNIQUE);
    expect(await pgCode(h.db.update(assetDerivatives).set({ status: 'ready' }).where(eq(assetDerivatives.id, d!.id)))).toBe(CHECK);
    // Ready also needs a size (0004); then the stored object identity (key, checksum) is frozen.
    expect(await pgCode(h.db.update(assetDerivatives).set({ status: 'ready', r2Key: `users/${owner}/d/${d!.id}.glb`, sha256: sha('c') }).where(eq(assetDerivatives.id, d!.id)))).toBe(CHECK);
    await h.db.update(assetDerivatives).set({ status: 'ready', r2Key: `users/${owner}/d/${d!.id}.glb`, sha256: sha('c'), sizeBytes: 10 }).where(eq(assetDerivatives.id, d!.id));
    expect(await pgCode(h.db.update(assetDerivatives).set({ sha256: sha('d') }).where(eq(assetDerivatives.id, d!.id)))).toBe(CHECK);
  });

  it('derivatives (0004): checksum format and owned key prefix', async () => {
    const [a] = await h.db.insert(assets).values({ ...PENDING, ownerId: owner, role: 'display-image', r2Key: `users/${owner}/assets/${randomUUID()}/original` }).returning();
    const base = { sourceAssetId: a!.id, outputType: 'image_object_usdz' as const, settings: {}, converterVersion: 'usd-image-plane@0.1.0' };
    expect(await pgCode(h.db.insert(assetDerivatives).values({ ...base, settingsHash: sha('1'), sha256: 'NOT-HEX' }))).toBe(CHECK);
    expect(await pgCode(h.db.insert(assetDerivatives).values({ ...base, settingsHash: sha('2'), r2Key: 'public/elsewhere.usdz' }))).toBe(CHECK);
    await h.db.insert(assetDerivatives).values({ ...base, settingsHash: sha('3'), r2Key: `users/${owner}/assets/${a!.id}/derivatives/x/display.usdz` });
  });

  it('jobs (0004): a failed job needs an error code', async () => {
    const [a] = await h.db.insert(assets).values({ ...PENDING, ownerId: owner, role: 'display-image', r2Key: `users/${owner}/assets/${randomUUID()}/original` }).returning();
    const base = { ownerId: owner, type: 'convert_image_to_ar' as const, assetId: a!.id, input: { kind: 'image-object' } };
    expect(await pgCode(h.db.insert(processingJobs).values({ ...base, idempotencyKey: `f-${randomUUID()}`, state: 'failed' }))).toBe(CHECK);
    await h.db.insert(processingJobs).values({ ...base, idempotencyKey: `f-${randomUUID()}`, state: 'failed', errorCode: 'converter_failed' });
  });

  it('generated outputs: one per revision × runtime; ready outputs are immutable', async () => {
    const e = await makeExperience(owner);
    const r = await makeRevision(e.id, 1, 'snapshot');
    const [o] = await h.db.insert(generatedOutputs).values({ revisionId: r.id, runtime: 'ios_quicklook_image' }).returning();
    expect(await pgCode(h.db.insert(generatedOutputs).values({ revisionId: r.id, runtime: 'ios_quicklook_image' }))).toBe(UNIQUE);
    const key = `experiences/${e.id}/revisions/${r.id}/ios/experience.usdz`;
    // Ready needs a size (0006).
    expect(await pgCode(h.db.update(generatedOutputs).set({ state: 'ready', r2Key: key, sha256: sha('e') }).where(eq(generatedOutputs.id, o!.id)))).toBe(CHECK);
    expect(await pgCode(h.db.update(generatedOutputs).set({ sizeBytes: 0 }).where(eq(generatedOutputs.id, o!.id)))).toBe(CHECK);
    await h.db.update(generatedOutputs).set({ state: 'ready', r2Key: key, sha256: sha('e'), sizeBytes: 1234 }).where(eq(generatedOutputs.id, o!.id));
    expect(await pgCode(h.db.update(generatedOutputs).set({ r2Key: 'experiences/x/other.usdz' }).where(eq(generatedOutputs.id, o!.id)))).toBe(CHECK);
    expect(await pgCode(h.db.insert(generatedOutputs).values({ revisionId: r.id, runtime: 'android_scene_viewer_image' as never }))).toBe('22P02');
  });

  it('analytics (0007): one row per experience × day × event × detail; counts never negative; detail format; deleted with the experience', async () => {
    const e = await makeExperience(owner);
    const row = { experienceId: e.id, day: '2026-11-23', event: 'view' as const, detail: 'ios', count: 1 };
    await h.db.insert(analyticsDaily).values(row);
    expect(await pgCode(h.db.insert(analyticsDaily).values(row))).toBe(UNIQUE);
    expect(await pgCode(h.db.insert(analyticsDaily).values({ ...row, detail: 'android', count: -1 }))).toBe(CHECK);
    expect(await pgCode(h.db.insert(analyticsDaily).values({ ...row, detail: 'Not Valid!' }))).toBe(CHECK);
    await h.db.delete(experiences).where(eq(experiences.id, e.id));
    expect(await h.db.select().from(analyticsDaily).where(eq(analyticsDaily.experienceId, e.id))).toEqual([]);
  });

  it('jobs: need a target, bounded attempts, unique idempotency keys', async () => {
    const [a] = await h.db.insert(assets).values({ ...PENDING, ownerId: owner, role: 'model', r2Key: `users/${owner}/assets/${randomUUID()}/original` }).returning();
    const key = `job-${randomUUID()}`;
    expect(await pgCode(h.db.insert(processingJobs).values({ ownerId: owner, type: 'validate_asset', idempotencyKey: `nt-${key}` }))).toBe(CHECK);
    await h.db.insert(processingJobs).values({ ownerId: owner, type: 'validate_asset', idempotencyKey: key, assetId: a!.id });
    expect(await pgCode(h.db.insert(processingJobs).values({ ownerId: owner, type: 'validate_asset', idempotencyKey: key, assetId: a!.id }))).toBe(UNIQUE);
    expect(
      await pgCode(h.db.insert(processingJobs).values({ ownerId: owner, type: 'validate_asset', idempotencyKey: `${key}-2`, assetId: a!.id, attempt: 4, maxAttempts: 3 })),
    ).toBe(CHECK);
  });
});

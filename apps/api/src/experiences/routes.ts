import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  CreateExperienceInput,
  ExperienceDetail,
  ExperienceId,
  ExperienceListResponse,
  ReadinessResponse,
  SaveDraftInput,
  UpdateExperienceInput,
  type ExperienceSummary,
} from '@ar-creator/contracts';
import { schema } from '@ar-creator/db';
import { DraftExperienceScene, defaultDraftScene, publishReadiness } from '@ar-creator/schema';
import type { AppEnv } from '../app.ts';
import { requireSession } from '../auth/middleware.ts';
import { err, parseJson } from '../http.ts';
import { assetReferenceIssues } from '../assets/references.ts';

const { experiences, experienceRevisions } = schema;
export const MAX_BODY_BYTES = 256 * 1024;

const notFound = (c: Context<AppEnv>) => err(c, 404, 'not_found', 'Experience not found.');

/** URL-safe slug from the name + random suffix (DB enforces format and uniqueness). */
export function makeSlug(name: string): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'experience';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const suffix = Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  return `${base}-${suffix}`;
}

type ExperienceRow = typeof experiences.$inferSelect;
function summary(e: ExperienceRow): ExperienceSummary {
  return {
    id: e.id,
    name: e.name,
    slug: e.slug,
    placementMode: e.placementMode,
    visibility: e.visibility,
    published: e.publishedRevisionId !== null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

const isUniqueViolation = (e: unknown) => {
  const x = e as { code?: string; cause?: { code?: string } };
  return (x.code ?? x.cause?.code) === '23505';
};

/**
 * Experience management (ADR-021). Every route requires a session; ownership is enforced in SQL, so another
 * user's experience is indistinguishable from a missing one (404, never 403).
 */
export function experienceRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireSession);
  r.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => err(c, 413, 'payload_too_large', 'The request is too large.') }));

  async function load(c: Context<AppEnv>, id: string) {
    if (!ExperienceId.safeParse(id).success) return null;
    const { db } = await c.get('db')();
    const rows = await db
      .select({ e: experiences, rev: experienceRevisions })
      .from(experiences)
      .leftJoin(experienceRevisions, eq(experienceRevisions.id, experiences.draftRevisionId))
      .where(and(eq(experiences.id, id), eq(experiences.ownerId, c.get('user').id)))
      .limit(1);
    return rows[0] ?? null;
  }

  function detail(row: NonNullable<Awaited<ReturnType<typeof load>>>): ExperienceDetail {
    if (!row.rev) throw new Error(`experience ${row.e.id} has no draft revision`);
    return ExperienceDetail.parse({
      ...summary(row.e),
      description: row.e.description,
      draftVersion: row.e.draftVersion,
      draft: { revisionId: row.rev.id, revisionNumber: row.rev.revisionNumber, scene: DraftExperienceScene.parse(row.rev.config) },
    });
  }

  r.get('/', async (c) => {
    const { db } = await c.get('db')();
    const rows = await db.select().from(experiences).where(eq(experiences.ownerId, c.get('user').id)).orderBy(desc(experiences.updatedAt)).limit(200);
    return c.json(ExperienceListResponse.parse({ experiences: rows.map(summary) }));
  });

  r.post('/', async (c) => {
    const p = await parseJson(c, CreateExperienceInput);
    if (!p.ok) return p.res;
    const { db } = await c.get('db')();
    const ownerId = c.get('user').id;
    const scene = defaultDraftScene(p.data.placementMode);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const id = await db.transaction(async (tx) => {
          const [e] = await tx
            .insert(experiences)
            .values({ ownerId, name: p.data.name, description: p.data.description ?? null, slug: makeSlug(p.data.name), placementMode: p.data.placementMode })
            .returning({ id: experiences.id });
          const [rev] = await tx
            .insert(experienceRevisions)
            .values({ experienceId: e!.id, revisionNumber: 1, state: 'draft', schemaVersion: scene.schemaVersion, config: scene, createdBy: ownerId })
            .returning({ id: experienceRevisions.id });
          await tx.update(experiences).set({ draftRevisionId: rev!.id }).where(eq(experiences.id, e!.id));
          return e!.id;
        });
        const row = await load(c, id);
        return c.json(detail(row!), 201);
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === 2) throw e; // retry only a (very unlikely) slug collision
      }
    }
    throw new Error('unreachable');
  });

  r.get('/:id', async (c) => {
    const row = await load(c, c.req.param('id'));
    return row ? c.json(detail(row)) : notFound(c);
  });

  r.patch('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ExperienceId.safeParse(id).success) return notFound(c);
    const p = await parseJson(c, UpdateExperienceInput);
    if (!p.ok) return p.res;
    const { db } = await c.get('db')();
    const set: Partial<typeof experiences.$inferInsert> = {};
    if (p.data.name !== undefined) set.name = p.data.name;
    if (p.data.description !== undefined) set.description = p.data.description || null;
    if (p.data.visibility !== undefined) set.visibility = p.data.visibility;
    const updated = await db
      .update(experiences)
      .set(set)
      .where(and(eq(experiences.id, id), eq(experiences.ownerId, c.get('user').id)))
      .returning({ id: experiences.id });
    if (!updated.length) return notFound(c);
    return c.json(detail((await load(c, id))!));
  });

  /** Scene configuration API: replace the draft scene (optimistic concurrency on draftVersion). */
  r.put('/:id/draft', async (c) => {
    const id = c.req.param('id');
    const current = await load(c, id);
    if (!current) return notFound(c);
    const p = await parseJson(c, SaveDraftInput);
    if (!p.ok) return p.res;
    const { scene, draftVersion, confirmPlacementChange } = p.data;
    if (draftVersion !== current.e.draftVersion) {
      return err(c, 409, 'conflict', 'This draft was changed elsewhere. Reload to get the latest version.', { reason: 'stale_draft', currentDraftVersion: current.e.draftVersion });
    }
    if (scene.placement.mode !== current.e.placementMode && !confirmPlacementChange) {
      return err(c, 409, 'conflict', 'Changing the placement mode must be confirmed.', { reason: 'placement_change_unconfirmed', currentDraftVersion: current.e.draftVersion });
    }
    const { db } = await c.get('db')();
    // Referenced assets must exist, belong to this user, be validated and have the right role (ADR-022).
    const refIssues = await assetReferenceIssues(db, c.get('user').id, scene);
    if (refIssues.length) return err(c, 400, 'bad_request', 'The draft references assets that cannot be used.', { issues: refIssues });
    const ok = await db.transaction(async (tx) => {
      // Conditional bump: only one concurrent writer with this draftVersion can win.
      const bumped = await tx
        .update(experiences)
        .set({ draftVersion: sql`${experiences.draftVersion} + 1`, placementMode: scene.placement.mode })
        .where(and(eq(experiences.id, id), eq(experiences.ownerId, c.get('user').id), eq(experiences.draftVersion, draftVersion)))
        .returning({ id: experiences.id });
      if (!bumped.length) return false;
      await tx
        .update(experienceRevisions)
        .set({ config: scene, schemaVersion: scene.schemaVersion })
        .where(and(eq(experienceRevisions.id, current.rev!.id), eq(experienceRevisions.state, 'draft')));
      return true;
    });
    if (!ok) {
      const latest = await load(c, id);
      return err(c, 409, 'conflict', 'This draft was changed elsewhere. Reload to get the latest version.', { reason: 'stale_draft', currentDraftVersion: latest?.e.draftVersion ?? 0 });
    }
    return c.json(detail((await load(c, id))!));
  });

  /** Publish-readiness report for the current draft (no changes). */
  r.post('/:id/validate', async (c) => {
    const row = await load(c, c.req.param('id'));
    if (!row) return notFound(c);
    return c.json(ReadinessResponse.parse(publishReadiness(detail(row).draft.scene)));
  });

  r.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ExperienceId.safeParse(id).success) return notFound(c);
    const { db } = await c.get('db')();
    const deleted = await db
      .delete(experiences)
      .where(and(eq(experiences.id, id), eq(experiences.ownerId, c.get('user').id)))
      .returning({ id: experiences.id });
    return deleted.length ? c.body(null, 204) : notFound(c);
  });

  return r;
}

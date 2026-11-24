/**
 * Daily maintenance (Phase 7 M21, ADR-039), run by the Worker's cron trigger:
 *   - upload slots that were never completed and expired more than an hour ago: row and any object at its key;
 *   - rejected uploads created more than 7 days ago (kept a week so the uploader can still see why): row + object;
 *   - rate-limit rows of the public endpoints idle for an hour (ADR-038).
 * Rows are deleted FIRST (atomically, with the state re-checked), then their objects: an upload finishing at that
 * moment can no longer mark its row validated, and the upload route then deletes its own object ("cancelled"), so
 * a validated asset never loses its file. If deleting an object fails it is logged (an untracked object, rare).
 * Rejected or expired uploads are never referenced by scenes (only validated assets can be).
 */
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { schema, type DbHandle } from '@ar-creator/db';
import type { ObjectStore } from './assets/store.ts';

const { assets } = schema;
export const SWEEP = { pendingGraceMs: 60 * 60 * 1000, rejectedRetentionMs: 7 * 24 * 60 * 60 * 1000, batch: 500 } as const;

export interface SweepResult {
  expiredSlots: number;
  rejected: number;
  objectDeleteFailures: number;
  rateLimitRows: number;
}

export async function sweep(db: DbHandle['db'], store: ObjectStore, now = new Date(), log: (detail: string) => void = () => undefined): Promise<SweepResult> {
  const pendingBefore = new Date(now.getTime() - SWEEP.pendingGraceMs);
  const rejectedBefore = new Date(now.getTime() - SWEEP.rejectedRetentionMs);
  const stale = or(and(eq(assets.state, 'pending_upload'), lt(assets.uploadExpiresAt, pendingBefore)), and(eq(assets.state, 'rejected'), lt(assets.createdAt, rejectedBefore)));
  const result: SweepResult = { expiredSlots: 0, rejected: 0, objectDeleteFailures: 0, rateLimitRows: 0 };
  for (;;) {
    const ids = await db.select({ id: assets.id }).from(assets).where(stale).limit(SWEEP.batch);
    if (ids.length === 0) break;
    const gone = await db
      .delete(assets)
      .where(and(inArray(assets.id, ids.map((r) => r.id)), stale))
      .returning({ state: assets.state, r2Key: assets.r2Key });
    for (const g of gone) {
      if (g.state === 'pending_upload') result.expiredSlots++;
      else result.rejected++;
      try {
        await store.delete(g.r2Key);
      } catch (e) {
        result.objectDeleteFailures++;
        log(`object delete failed for ${g.r2Key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (ids.length < SWEEP.batch) break;
  }
  const rl = await db.execute(sql`DELETE FROM rate_limit WHERE key LIKE 'app:%' AND last_request < ${now.getTime() - 3600_000}`);
  result.rateLimitRows = rl.rowCount ?? 0;
  return result;
}

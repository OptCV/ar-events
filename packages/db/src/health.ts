import type { Client } from 'pg';
import journal from '../migrations/meta/_journal.json' with { type: 'json' };
import { classifyDbError, type DbFailureKind } from './client.ts';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** Latest migration bundled with this build (drizzle-kit journal). */
export const EXPECTED_MIGRATION = (() => {
  const entries = (journal as { entries: JournalEntry[] }).entries;
  const last = entries[entries.length - 1];
  if (!last) throw new Error('migration journal is empty');
  return { count: entries.length, tag: last.tag, when: last.when };
})();

export type MigrationStatus = 'current' | 'behind' | 'ahead' | 'unknown';

export interface DatabaseHealth {
  ok: boolean;
  latencyMs: number;
  migrations: MigrationStatus;
  /** Present when ok=false; safe category only. */
  error?: DbFailureKind;
  /** Redacted; for server logs only, never for responses. */
  logDetail?: string;
}

/**
 * Liveness + schema check: `SELECT 1`, then compare the newest applied drizzle migration with the newest
 * bundled one. `behind` means production migrations have not been applied (requires owner approval).
 */
export async function checkDatabase(client: Client, now: () => number = () => performance.now()): Promise<DatabaseHealth> {
  const t0 = now();
  try {
    await client.query('SELECT 1');
    let migrations: MigrationStatus = 'unknown';
    try {
      const r = await client.query<{ created_at: string | null }>('SELECT max(created_at)::text AS created_at FROM drizzle.__drizzle_migrations');
      const applied = r.rows[0]?.created_at ? Number(r.rows[0].created_at) : null;
      if (applied === null) migrations = 'behind';
      else if (applied === EXPECTED_MIGRATION.when) migrations = 'current';
      else migrations = applied < EXPECTED_MIGRATION.when ? 'behind' : 'ahead';
    } catch (err) {
      // Missing migrations table = never migrated.
      migrations = (err as { code?: string }).code === '42P01' || (err as { code?: string }).code === '3F000' ? 'behind' : 'unknown';
    }
    return { ok: true, latencyMs: Math.round(now() - t0), migrations };
  } catch (err) {
    const e = classifyDbError(err);
    return { ok: false, latencyMs: Math.round(now() - t0), migrations: 'unknown', error: e.kind, logDetail: e.detail };
  }
}

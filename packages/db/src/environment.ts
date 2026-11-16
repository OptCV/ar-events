import type { Client } from 'pg';

export type EnvironmentMarker = 'development' | 'production' | 'conflict' | null;

const PATTERN = /\bar\.environment=(development|production)\b/;

/**
 * The database's own statement of which environment it is (ADR-018), checked before any remote migration.
 * Two accepted forms, because Neon's `neondb_owner` is not a superuser and gets
 * "permission denied to set parameter" (42501) for `ALTER DATABASE … SET ar.environment`:
 *   1. database comment (owner can always set; anyone can read):
 *        COMMENT ON DATABASE neondb IS 'ar.environment=development';
 *   2. database-level parameter (needs superuser; used by local Docker rehearsals):
 *        ALTER DATABASE x SET ar.environment = 'development';
 * If both exist and disagree the result is "conflict" and every guarded operation refuses.
 */
export async function readEnvironmentMarker(c: Client): Promise<EnvironmentMarker> {
  const r = await c.query<{ comment: string | null; setting: string | null }>(
    `SELECT shobj_description(d.oid, 'pg_database') AS comment, current_setting('ar.environment', true) AS setting
     FROM pg_database d WHERE d.datname = current_database()`,
  );
  const row = r.rows[0];
  const fromComment = (row?.comment && PATTERN.exec(row.comment)?.[1]) || null;
  const fromSetting = row?.setting === 'development' || row?.setting === 'production' ? row.setting : null;
  if (fromComment && fromSetting && fromComment !== fromSetting) return 'conflict';
  return (fromComment ?? fromSetting) as EnvironmentMarker;
}

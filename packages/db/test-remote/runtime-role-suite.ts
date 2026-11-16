/**
 * Checks for the database as seen by the RUNTIME role (`ar_app`, the role Hyperdrive should use).
 * Used by:
 *   - packages/db/test/roles.test.ts       → local rehearsal against Docker with real roles
 *   - packages/db/test-remote/neon.test.ts → your Neon branch (via `npm run db:remote -- verify`)
 * Every write happens inside a transaction that is ROLLED BACK: the target database is left unchanged.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Client } from 'pg';
import { checkDatabase } from '../src/health.ts';
import { clientTls } from '../src/tls.ts';
import { readEnvironmentMarker } from '../src/environment.ts';

export interface RuntimeRoleSuiteOptions {
  /** Connection string for the runtime role; resolved lazily so nothing is read at import time. */
  url: () => string;
  /** Expected `ar.environment` database marker, e.g. "development". */
  expectEnvironment: string;
  /** Require TLS on the connection (true for Neon). */
  requireTls: boolean;
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url, application_name: 'ar-creator-verify', connectionTimeoutMillis: 10_000 });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/** Run `fn` in a transaction that is always rolled back. */
async function rolledBack(url: string, fn: (c: Client) => Promise<void>) {
  await withClient(url, async (c) => {
    await c.query('BEGIN');
    try {
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  }
}

export function defineRuntimeRoleSuite(o: RuntimeRoleSuiteOptions) {
  it('targets the expected environment (ar.environment marker)', async () => {
    const env = await withClient(o.url(), (c) => readEnvironmentMarker(c));
    expect(env).toBe(o.expectEnvironment);
  });

  it('connects as a non-superuser runtime role without DDL rights', async () => {
    await withClient(o.url(), async (c) => {
      const r = await c.query<{ super: boolean; createdb: boolean; createrole: boolean; can_create: boolean; owns: string }>(
        `SELECT rolsuper AS super, rolcreatedb AS createdb, rolcreaterole AS createrole,
                has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
                (SELECT count(*)::text FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns
         FROM pg_roles WHERE rolname = current_user`,
      );
      expect(r.rows[0]).toEqual({ super: false, createdb: false, createrole: false, can_create: false, owns: '0' });
    });
  });

  if (o.requireTls) {
    it('uses TLS with a verified certificate (client side; pg_stat_ssl sees only Neon proxy→compute)', async () => {
      const tls = await withClient(o.url(), async (c) => clientTls(c));
      expect(tls).toMatchObject({ encrypted: true, verified: true });
    });
  }

  it('sees all bundled migrations applied (health "current")', async () => {
    const h = await withClient(o.url(), (c) => checkDatabase(c));
    expect(h).toMatchObject({ ok: true, migrations: 'current' });
  });

  it('cannot run DDL or drop data structures', async () => {
    await withClient(o.url(), async (c) => {
      expect(await sqlState(c.query('CREATE TABLE ar_should_not_exist (id int)'))).toBe('42501');
      expect(await sqlState(c.query('DROP TABLE experiences'))).toBe('42501');
      expect(await sqlState(c.query('ALTER TABLE "user" ADD COLUMN x int'))).toBe('42501');
      expect(await sqlState(c.query('TRUNCATE "session"'))).toBe('42501');
    });
  });

  it('session queries: create, look up by token, expire, revoke (rolled back)', async () => {
    await rolledBack(o.url(), async (c) => {
      const uid = `verify-${randomUUID()}`;
      const token = randomUUID();
      await c.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [uid, 'Verify', `${uid}@example.invalid`]);
      await c.query(
        `INSERT INTO "session" (id, token, user_id, expires_at, updated_at) VALUES ($1, $2, $3, now() + interval '1 hour', now())`,
        [randomUUID(), token, uid],
      );
      // Same shape of lookup Better Auth performs for getSession: session by token joined to its user.
      const live = await c.query(
        `SELECT s.id FROM "session" s JOIN "user" u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now()`,
        [token],
      );
      expect(live.rowCount).toBe(1);
      await c.query(`UPDATE "session" SET expires_at = now() - interval '1 second' WHERE token = $1`, [token]);
      const expired = await c.query(`SELECT 1 FROM "session" WHERE token = $1 AND expires_at > now()`, [token]);
      expect(expired.rowCount).toBe(0);
      await c.query('DELETE FROM "session" WHERE token = $1', [token]);
      expect((await c.query('SELECT 1 FROM "session" WHERE token = $1', [token])).rowCount).toBe(0);
      // Rate-limit table used by Better Auth's database storage.
      await c.query('INSERT INTO rate_limit (id, key, count, last_request) VALUES ($1, $2, 1, $3)', [randomUUID(), `verify:${uid}`, Date.now()]);
    });
  });

  it('immutability triggers fire for the runtime role (rolled back)', async () => {
    await rolledBack(o.url(), async (c) => {
      const uid = `verify-${randomUUID()}`;
      await c.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [uid, 'Verify', `${uid}@example.invalid`]);
      const e = await c.query<{ id: string }>(
        `INSERT INTO experiences (owner_id, name, slug, placement_mode) VALUES ($1, 'Verify', $2, 'floor') RETURNING id`,
        [uid, `verify-${randomUUID().slice(0, 8)}`],
      );
      const r = await c.query<{ id: string }>(
        `INSERT INTO experience_revisions (experience_id, revision_number, state, schema_version, config, frozen_at)
         VALUES ($1, 1, 'snapshot', 1, '{}'::jsonb, now()) RETURNING id`,
        [e.rows[0]!.id],
      );
      await c.query('SAVEPOINT sp');
      expect(await sqlState(c.query(`UPDATE experience_revisions SET config = '{"x":1}'::jsonb WHERE id = $1`, [r.rows[0]!.id]))).toBe('23514');
      await c.query('ROLLBACK TO SAVEPOINT sp');
    });
  });

  it('leaves no verification data behind', async () => {
    const n = await withClient(o.url(), async (c) => (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM "user" WHERE id LIKE 'verify-%'`)).rows[0]!.n);
    expect(n).toBe('0');
  });
}

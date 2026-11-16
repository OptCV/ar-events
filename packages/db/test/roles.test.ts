/**
 * Local rehearsal of the Neon role model (ADR-018): database owner → ar_migrator (DDL, owns objects) → ar_app
 * (runtime DML only). Uses the exact SQL files and migration runner used for Neon.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { defineRuntimeRoleSuite } from '../test-remote/runtime-role-suite.ts';
import { MIGRATIONS_DIR, baseUrl, createTempDatabase } from './helpers.ts';

const sql = (f: string) => readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8');
const pw = { ar_migrator: randomBytes(18).toString('hex'), ar_app: randomBytes(18).toString('hex') };
let temp: Awaited<ReturnType<typeof createTempDatabase>>;

function roleUrl(role: keyof typeof pw): string {
  const u = new URL(temp.url);
  u.username = role;
  u.password = pw[role];
  return u.toString();
}

async function asUrl(url: string, fn: (c: Client) => Promise<void>) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  // Cluster-level roles (local only). Passwords are random per run and never leave this process.
  await asUrl(baseUrl(), async (c) => {
    for (const role of ['ar_migrator', 'ar_app'] as const) {
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN; END IF; END $$`);
      await c.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${pw[role]}'`);
    }
  });
  temp = await createTempDatabase();
  // Step 1 as the database owner (+ environment marker)
  await asUrl(temp.url, async (c) => {
    // Same form as on Neon (neondb_owner cannot ALTER DATABASE … SET a custom parameter: 42501).
    await c.query(`COMMENT ON DATABASE ${temp.name} IS 'AR Creator database. ar.environment=development'`);
    await c.query(sql('01-owner-setup.sql'));
  });
  // Migrations + step 2 as ar_migrator — exactly what `db:remote migrate` does
  await asUrl(roleUrl('ar_migrator'), async (c) => {
    await migrate(drizzle(c), { migrationsFolder: MIGRATIONS_DIR });
    await c.query(sql('02-app-grants.sql'));
  });
}, 60_000);

afterAll(async () => {
  await temp?.drop();
});

describe('Neon role model (local rehearsal)', () => {
  it('ar_migrator owns every application table', async () => {
    await asUrl(temp.url, async (c) => {
      const r = await c.query<{ owner: string }>("SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname IN ('public', 'drizzle')");
      expect(r.rows.map((x) => x.owner)).toEqual(['ar_migrator']);
    });
  });

  it('ar_app cannot run migrations', async () => {
    let code = 'ok';
    await asUrl(roleUrl('ar_app'), async (c) => {
      await migrate(drizzle(c), { migrationsFolder: MIGRATIONS_DIR }).catch((e) => (code = (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code ?? 'error'));
    });
    expect(code).toBe('42501');
  });

  it('02-app-grants.sql is idempotent', async () => {
    await asUrl(roleUrl('ar_migrator'), async (c) => {
      await c.query(sql('02-app-grants.sql'));
    });
  });

  describe('runtime role suite (same checks as Neon)', () => {
    defineRuntimeRoleSuite({ url: () => roleUrl('ar_app'), expectEnvironment: 'development', requireTls: false });
  });
});

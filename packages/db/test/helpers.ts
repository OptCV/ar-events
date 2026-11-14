import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url).href);

export function baseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Fail loudly: DB tests must never be silently skipped (CLAUDE.md "do not invent passing checks").
    throw new Error('DATABASE_URL not set. Run `npm run db:up` (creates .env and starts Docker Postgres).');
  }
  return url;
}

export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Create an isolated, empty database; returns its URL and a dropper. */
export async function createTempDatabase(): Promise<{ url: string; name: string; drop: () => Promise<void> }> {
  const name = `ar_test_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: baseUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return {
    name,
    url: withDatabase(baseUrl(), name),
    drop: async () => {
      const a = new Client({ connectionString: baseUrl() });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function migrateDatabase(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client.end();
  }
}

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { AssetRole } from '@ar-creator/schema';
import { RUNTIMES } from '@ar-creator/platform-launch/runtime';
import * as schema from '../src/schema/index.ts';
import { EXPECTED_MIGRATION, checkDatabase } from '../src/health.ts';
import { createTempDatabase, migrateDatabase } from './helpers.ts';

const TABLES = [
  'account',
  'analytics_daily',
  'asset_derivatives',
  'assets',
  'experience_revisions',
  'experiences',
  'generated_outputs',
  'processing_jobs',
  'rate_limit',
  'session',
  'user',
  'verification',
];

let temp: Awaited<ReturnType<typeof createTempDatabase>>;
let client: Client;

beforeAll(async () => {
  temp = await createTempDatabase();
  client = new Client({ connectionString: temp.url });
  await client.connect();
});
afterAll(async () => {
  await client?.end();
  await temp?.drop();
});

describe('migrations', () => {
  it('an empty database reports migrations "behind" before migrating', async () => {
    const h = await checkDatabase(client);
    expect(h).toMatchObject({ ok: true, migrations: 'behind' });
  });

  it('apply cleanly to an empty database', async () => {
    await migrateDatabase(temp.url);
    const r = await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    expect(r.rows.map((x) => x.tablename)).toEqual(TABLES);
    const m = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations');
    expect(Number(m.rows[0]!.n)).toBe(EXPECTED_MIGRATION.count);
    expect(await checkDatabase(client)).toMatchObject({ ok: true, migrations: 'current' });
  });

  it('are idempotent (re-running applies nothing)', async () => {
    await migrateDatabase(temp.url);
    const m = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations');
    expect(Number(m.rows[0]!.n)).toBe(EXPECTED_MIGRATION.count);
  });

  it('install the immutability triggers', async () => {
    const r = await client.query<{ tgname: string }>('SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname');
    expect(r.rows.map((x) => x.tgname)).toEqual(['asset_derivatives_immutable', 'experience_revisions_immutable', 'generated_outputs_immutable']);
  });

  it('the TypeScript schema has no changes missing from the committed migrations (no drift)', async () => {
    const snapshotFile = new URL(`../migrations/meta/${String(EXPECTED_MIGRATION.count - 1).padStart(4, '0')}_snapshot.json`, import.meta.url);
    const prev = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    const cur = generateDrizzleJson(schema as Record<string, unknown>, prev.id);
    expect(await generateMigration(prev, cur)).toEqual([]);
  });

  it('database enums match the TypeScript sources of truth', async () => {
    const r = await client.query<{ typname: string; labels: string[] }>(
      `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`,
    );
    const byName = Object.fromEntries(r.rows.map((x) => [x.typname, x.labels]));
    expect(byName.asset_role).toEqual([...AssetRole.options]);
    expect(byName.runtime).toEqual([...RUNTIMES]);
    expect(byName.placement_mode).toEqual(['image', 'floor', 'wall']);
  });
});

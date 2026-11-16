import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readEnvironmentMarker } from '../src/environment.ts';
import { createTempDatabase } from './helpers.ts';

let temp: Awaited<ReturnType<typeof createTempDatabase>>;
beforeAll(async () => {
  temp = await createTempDatabase();
});
afterAll(async () => temp?.drop());

/** Each case uses a NEW connection: database-level settings apply at session start. */
async function markerAfter(sql: string[]) {
  const admin = new Client({ connectionString: temp.url });
  await admin.connect();
  for (const q of sql) await admin.query(q);
  await admin.end();
  const c = new Client({ connectionString: temp.url });
  await c.connect();
  try {
    return await readEnvironmentMarker(c);
  } finally {
    await c.end();
  }
}

describe('readEnvironmentMarker', () => {
  it('none set → null', async () => {
    expect(await markerAfter([`COMMENT ON DATABASE ${temp.name} IS NULL`, `ALTER DATABASE ${temp.name} RESET ar.environment`])).toBeNull();
  });
  it('comment only (Neon form) → value, even with surrounding text', async () => {
    expect(await markerAfter([`COMMENT ON DATABASE ${temp.name} IS 'AR Creator dev. ar.environment=development'`])).toBe('development');
  });
  it('unrelated or malformed comment → null', async () => {
    expect(await markerAfter([`COMMENT ON DATABASE ${temp.name} IS 'ar.environment=staging'`])).toBeNull();
    expect(await markerAfter([`COMMENT ON DATABASE ${temp.name} IS 'xar.environment=productionx'`])).toBeNull();
  });
  it('parameter only (superuser form) → value', async () => {
    expect(await markerAfter([`COMMENT ON DATABASE ${temp.name} IS NULL`, `ALTER DATABASE ${temp.name} SET ar.environment = 'production'`])).toBe('production');
  });
  it('both agree → value; both disagree → "conflict"', async () => {
    expect(await markerAfter([`COMMENT ON DATABASE ${temp.name} IS 'ar.environment=production'`])).toBe('production');
    expect(await markerAfter([`COMMENT ON DATABASE ${temp.name} IS 'ar.environment=development'`])).toBe('conflict');
  });
});

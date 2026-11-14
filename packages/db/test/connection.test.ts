import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseError, classifyDbError, connectDb } from '../src/client.ts';
import { checkDatabase } from '../src/health.ts';
import { redact } from '../src/redact.ts';
import { baseUrl, createTempDatabase, migrateDatabase, withDatabase } from './helpers.ts';

const password = () => decodeURIComponent(new URL(baseUrl()).password);

async function failure(p: Promise<unknown>): Promise<DatabaseError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DatabaseError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

let temp: Awaited<ReturnType<typeof createTempDatabase>>;
beforeAll(async () => {
  temp = await createTempDatabase();
  await migrateDatabase(temp.url);
});
afterAll(async () => temp?.drop());

describe('connectDb (per-request connection)', () => {
  it('connects, reports healthy + current migrations, and closes idempotently', async () => {
    const h = await connectDb(temp.url);
    const health = await checkDatabase(h.client);
    expect(health).toMatchObject({ ok: true, migrations: 'current' });
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    const app = await h.client.query<{ application_name: string }>('SHOW application_name');
    expect(app.rows[0]!.application_name).toBe('ar-creator');
    await h.close();
    await h.close();
  });

  it('wrong password → "auth", and the password never appears in the error', async () => {
    const u = new URL(temp.url);
    u.password = 'definitely-wrong-password-123';
    const e = await failure(connectDb(u.toString()));
    expect(e.kind).toBe('auth');
    expect(e.message).toBe('database auth');
    expect(e.detail).not.toContain('definitely-wrong-password-123');
    expect(e.detail).not.toContain(password());
  });

  it('unreachable host/port → "unreachable" within the connect timeout', async () => {
    const u = new URL(temp.url);
    u.port = '1'; // nothing listens there
    const t0 = Date.now();
    const e = await failure(connectDb(u.toString(), { connectionTimeoutMs: 2_000 }));
    expect(e.kind).toBe('unreachable');
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(e.detail).not.toContain(password());
  });

  it('non-existent database → "misconfigured"', async () => {
    const e = await failure(connectDb(withDatabase(baseUrl(), 'no_such_database_xyz')));
    expect(e.kind).toBe('misconfigured');
  });

  it('empty connection string → "not_configured" without attempting a connection', async () => {
    expect((await failure(connectDb(''))).kind).toBe('not_configured');
  });

  it('statement_timeout cancels runaway queries → "timeout"', async () => {
    const h = await connectDb(temp.url, { statementTimeoutMs: 200 });
    try {
      let caught: unknown;
      await h.client.query('SELECT pg_sleep(2)').catch((e) => (caught = e));
      expect(classifyDbError(caught).kind).toBe('timeout');
    } finally {
      await h.close();
    }
  });

  it('checkDatabase on a dead connection reports a safe error category', async () => {
    const h = await connectDb(temp.url);
    await h.close();
    const health = await checkDatabase(h.client);
    expect(health.ok).toBe(false);
    expect(health.migrations).toBe('unknown');
    expect(['unreachable', 'unknown', 'query_failed']).toContain(health.error);
    expect(health.logDetail ?? '').not.toContain(password());
  });
});

describe('redact', () => {
  it('strips credentials from URLs, key=value pairs and known DB hosts', () => {
    const s = redact('connect to postgres://ar_creator:s3cr3t@ep-cool-123.us-east-2.aws.neon.tech:5432/db?sslmode=require password=hunter2 token: abc');
    expect(s).not.toMatch(/s3cr3t|hunter2|abc\b|neon\.tech/);
    expect(s).toContain('postgres://***@');
    expect(s).toContain('<db-host>');
    expect(redact('plain message')).toBe('plain message');
  });
});

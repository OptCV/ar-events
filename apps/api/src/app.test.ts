import { describe, expect, it, vi } from 'vitest';
import { ApiError, HealthResponse } from '@ar-creator/contracts';
import { DatabaseError, EXPECTED_MIGRATION, type DbHandle } from '@ar-creator/db';
import { createApp } from './app.ts';
import type { DbConnector } from './db.ts';

/** Fake per-request connection: answers the two health queries; records closes. */
function fakeDb(opts: { appliedWhen?: number | null; failQuery?: Error } = {}) {
  const closes: number[] = [];
  let connects = 0;
  const connector: DbConnector = async () => {
    connects++;
    const client = {
      query: async (sql: string) => {
        if (opts.failQuery) throw opts.failQuery;
        if (sql.includes('__drizzle_migrations')) {
          const when = opts.appliedWhen === undefined ? EXPECTED_MIGRATION.when : opts.appliedWhen;
          return { rows: [{ created_at: when === null ? null : String(when) }] };
        }
        return { rows: [{ '?column?': 1 }] };
      },
    };
    return { client, db: {}, close: async () => void closes.push(Date.now()) } as unknown as DbHandle;
  };
  return { connector, closes, connects: () => connects };
}

const app = createApp({ version: '0.1.0', build: 'test-sha' }, { connectDb: fakeDb().connector });

describe('GET /api/health', () => {
  it('returns a contract-valid body with build info and a healthy database', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body).toMatchObject({ status: 'ok', service: 'ar-creator', version: '0.1.0', build: 'test-sha' });
    expect(body.checks.database).toMatchObject({ status: 'ok', migrations: 'current' });
    expect(body.runtime).toBe('other'); // Node test runner; workerd is asserted in the Playwright suites
  });

  it('opens exactly one connection per request and closes it', async () => {
    const f = fakeDb();
    const a = createApp({ version: 'x', build: 'y' }, { connectDb: f.connector });
    await a.request('/api/health');
    await a.request('/api/health');
    await new Promise((r) => setTimeout(r, 0));
    expect(f.connects()).toBe(2);
    expect(f.closes).toHaveLength(2);
  });

  it('routes that do not use the database never connect', async () => {
    const f = fakeDb();
    const a = createApp({ version: 'x', build: 'y' }, { connectDb: f.connector });
    await a.request('/api/nope');
    expect(f.connects()).toBe(0);
  });

  it('pending migrations → 503 degraded with migrations "behind"', async () => {
    const a = createApp({ version: 'x', build: 'y' }, { connectDb: fakeDb({ appliedWhen: EXPECTED_MIGRATION.when - 1 }).connector });
    const res = await a.request('/api/health');
    expect(res.status).toBe(503);
    expect(HealthResponse.parse(await res.json())).toMatchObject({ status: 'degraded', checks: { database: { status: 'ok', migrations: 'behind' } } });
  });

  it.each([
    ['auth', new DatabaseError('auth', 'password authentication failed; postgres://u:hunter2@ep-x.us-east-2.aws.neon.tech/db')],
    ['not_configured', new DatabaseError('not_configured', 'HYPERDRIVE binding is missing')],
    ['unreachable', Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), { code: 'ECONNREFUSED' })],
  ])('connection failure (%s) → 503 with a safe category; secrets only in redacted logs', async (kind, error) => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => void logs.push(String(m)));
    try {
      const a = createApp({ version: 'x', build: 'y' }, { connectDb: async () => Promise.reject(error) });
      const res = await a.request('/api/health');
      const text = await res.text();
      expect(res.status).toBe(503);
      const body = HealthResponse.parse(JSON.parse(text));
      expect(body).toMatchObject({ status: 'degraded', checks: { database: { status: 'error', error: kind } } });
      expect(text).not.toMatch(/hunter2|neon\.tech|10\.0\.0\.5|ECONNREFUSED|password/);
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain('hunter2');
      expect(logs[0]).not.toContain('neon.tech');
    } finally {
      spy.mockRestore();
    }
  });

  it('query failure on a live connection → 503 with error category and the connection is still closed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fakeDb({ failQuery: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) });
    const a = createApp({ version: 'x', build: 'y' }, { connectDb: f.connector });
    const res = await a.request('/api/health');
    expect(res.status).toBe(503);
    expect(HealthResponse.parse(await res.json()).checks.database).toMatchObject({ status: 'error', error: 'timeout' });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.closes).toHaveLength(1);
    spy.mockRestore();
  });

  it('is never cached and carries API security headers', async () => {
    const res = await app.request('/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('errors', () => {
  it('unknown API routes return the JSON error contract', async () => {
    const res = await app.request('/api/does-not-exist');
    expect(res.status).toBe(404);
    const body = ApiError.parse(await res.json());
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
  });

  it('unexpected exceptions become a generic 500 without leaking internals', async () => {
    const boom = createApp({ version: 'x', build: 'y' });
    boom.get('/boom', () => {
      throw new Error('db password=hunter2 at /internal/path');
    });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      const res = await boom.request('/api/boom');
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('/internal/path');
      expect(ApiError.parse(JSON.parse(text)).error.code).toBe('internal');
      expect(errors).toHaveLength(1); // logged server-side once…
      expect(JSON.stringify(errors)).not.toContain('hunter2'); // …and redacted
    } finally {
      console.error = orig;
    }
  });

  it('database errors in any route → 503 unavailable; other coded errors stay 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = createApp({ version: 'x', build: 'y' }, { connectDb: fakeDb().connector });
    a.get('/db-fail', () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    });
    a.get('/fs-fail', () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    });
    const db = await a.request('/api/db-fail');
    expect(db.status).toBe(503);
    expect(ApiError.parse(await db.json()).error.code).toBe('unavailable');
    const other = await a.request('/api/fs-fail');
    expect(other.status).toBe(500);
    expect(ApiError.parse(await other.json()).error.code).toBe('internal');
    spy.mockRestore();
  });

  it('paths outside /api are not handled by the API', async () => {
    const res = await app.request('/dashboard');
    expect(res.status).toBe(404);
  });
});

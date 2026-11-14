import type { Context, MiddlewareHandler } from 'hono';
import { connectDb, DatabaseError, redact, type DbHandle } from '@ar-creator/db';
import type { AppBindings, AppEnv } from './app.ts';

export type DbConnector = (env: AppBindings) => Promise<DbHandle>;

/**
 * Production connector: one new pg connection per request through the Hyperdrive binding (ADR-013, ADR-017).
 * The Hyperdrive config has query caching DISABLED, so auth/session/permission reads are never stale.
 * Locally, `vite dev`/`vite preview` substitute CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
 * (from the gitignored .env) for the real binding.
 */
export const hyperdriveConnector: DbConnector = async (env) => {
  const hyperdrive = (env as Partial<{ HYPERDRIVE: Hyperdrive }>).HYPERDRIVE;
  if (!hyperdrive?.connectionString) throw new DatabaseError('not_configured', 'HYPERDRIVE binding is missing');
  return connectDb(hyperdrive.connectionString, { connectionTimeoutMs: 5_000, statementTimeoutMs: 10_000 });
};

/**
 * Exposes `c.get('db')()` — a lazy, memoised per-request connection. Routes that never touch the database
 * never connect. The connection is closed after the response via `waitUntil` (never reused across requests).
 */
export function dbMiddleware(connect: DbConnector): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const state: { handle: Promise<DbHandle> | null } = { handle: null };
    c.set('db', () => (state.handle ??= connect(c.env)));
    try {
      await next();
    } finally {
      if (state.handle) {
        const closing = state.handle.then(
          (h) => h.close(),
          () => undefined,
        );
        runAfterResponse(c, closing);
      }
    }
  };
}

function runAfterResponse(c: Context<AppEnv>, p: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // No ExecutionContext (unit tests in Node): just let it settle.
    void p;
  }
}

/** Structured, redacted error log for Workers Observability. */
export function logError(c: Context<AppEnv>, event: string, detail: string) {
  console.error(JSON.stringify({ level: 'error', event, requestId: c.get('requestId'), path: c.req.path, detail: redact(detail) }));
}

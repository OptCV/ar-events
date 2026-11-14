import { Hono, type Context } from 'hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { HealthResponse, type ApiError, type ApiErrorCode, type DatabaseCheck } from '@ar-creator/contracts';
import { checkDatabase, classifyDbError, DatabaseError, type DbHandle } from '@ar-creator/db';
import { dbMiddleware, hyperdriveConnector, logError, type DbConnector } from './db.ts';

export interface BuildInfo {
  version: string;
  build: string;
}

export interface AppDeps {
  /** Defaults to the Hyperdrive connector; tests inject fakes. */
  connectDb?: DbConnector;
}

/** Runtime bindings, generated from apps/web/wrangler.jsonc by `npm run cf-typegen -w @ar-creator/web`. */
export type AppBindings = Env;
export type AppEnv = { Bindings: AppBindings; Variables: { requestId: string; db: () => Promise<DbHandle> } };

function detectRuntime(): HealthResponse['runtime'] {
  // workerd sets this exact UA (https://developers.cloudflare.com/workers/runtime-apis/web-standards/#navigatoruseragent).
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers' ? 'workerd' : 'other';
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** DatabaseError, a pg error (5-char SQLSTATE), or a Drizzle query error wrapping one. */
export function isDatabaseError(err: unknown): boolean {
  if (err instanceof DatabaseError) return true;
  const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  if (!e || typeof e !== 'object') return false;
  if (typeof e.code === 'string' && SQLSTATE.test(e.code)) return true;
  return e.name === 'DrizzleQueryError' || (typeof e.cause?.code === 'string' && SQLSTATE.test(e.cause.code));
}

export function apiError(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 405 | 500 | 503, code: ApiErrorCode, message: string) {
  const body: ApiError = { error: { code, message, requestId: c.get('requestId') } };
  return c.json(body, status);
}

/**
 * The API is mounted under /api. In the deployed Worker, Workers Static Assets serves the SPA and only
 * `/api/*` reaches this code (`assets.run_worker_first`, ADR-014).
 */
export function createApp(info: BuildInfo, deps: AppDeps = {}) {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', requestId());
  app.use('*', dbMiddleware(deps.connectDb ?? hyperdriveConnector));
  app.use(
    '*',
    secureHeaders({
      // JSON API: nothing may be rendered or framed from these responses.
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      crossOriginResourcePolicy: 'same-origin',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }),
  );
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.get('/health', async (c) => {
    let database: DatabaseCheck;
    try {
      const handle = await c.get('db')();
      const r = await checkDatabase(handle.client);
      database = r.ok ? { status: 'ok', latencyMs: r.latencyMs, migrations: r.migrations } : { status: 'error', latencyMs: r.latencyMs, error: r.error ?? 'unknown' };
      if (!r.ok) logError(c, 'health.database', r.logDetail ?? r.error ?? 'unknown');
    } catch (err) {
      const e = classifyDbError(err);
      database = { status: 'error', error: e.kind };
      logError(c, 'health.database', e.detail);
    }
    const degraded = database.status === 'error' || database.migrations === 'behind';
    const body = HealthResponse.parse({
      status: degraded ? 'degraded' : 'ok',
      service: 'ar-creator',
      version: info.version,
      build: info.build,
      runtime: detectRuntime(),
      time: new Date().toISOString(),
      checks: { database },
    });
    return c.json(body, degraded ? 503 : 200);
  });

  app.notFound((c) => apiError(c, 404, 'not_found', 'No such API route.'));
  app.onError((err, c) => {
    // Structured, redacted log for Workers Observability; responses never leak internals.
    if (isDatabaseError(err)) {
      const e = classifyDbError(err);
      logError(c, 'db.error', `${e.kind}: ${e.detail}`);
      return apiError(c, 503, 'unavailable', 'The service is temporarily unavailable. Please try again.');
    }
    logError(c, 'unhandled', err.message);
    return apiError(c, 500, 'internal', 'Something went wrong. Please try again.');
  });

  return app;
}

export type App = ReturnType<typeof createApp>;

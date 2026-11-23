import { Hono, type Context } from 'hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { AuthConfigResponse, HealthResponse, MeResponse, SessionResponse, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type ApiError, type ApiErrorCode, type DatabaseCheck, type SessionUser } from '@ar-creator/contracts';
import { checkDatabase, classifyDbError, DatabaseError, type DbHandle } from '@ar-creator/db';
import { dbMiddleware, hyperdriveConnector, logError, type DbConnector } from './db.ts';
import type { Auth } from './auth/auth.ts';
import type { AuthConfig } from './auth/config.ts';
import { AuthUnavailableError, authContext, isAllowedAuthRoute, redirectsOffOrigin, requireSession, sameOriginMutations, unsafeRedirectIn } from './auth/middleware.ts';
import { DevMailbox, type Mailer } from './email/mailer.ts';
import { experienceRoutes } from './experiences/routes.ts';
import { StorageUnavailableError, assetRoutes } from './assets/routes.ts';
import { r2Store, type ObjectStore } from './assets/store.ts';
import { conversionRoutes } from './conversions/routes.ts';
import { workflowRunner, type ConversionRunner } from './conversions/runner.ts';

export interface BuildInfo {
  version: string;
  build: string;
}

export interface AppDeps {
  /** Defaults to the Hyperdrive connector; tests inject fakes. */
  connectDb?: DbConnector;
  /** Tests inject a capturing mailer. */
  mailer?: (cfg: AuthConfig) => Mailer;
  /** Defaults to R2 via the ASSETS_BUCKET binding; tests inject an in-memory store. */
  objectStore?: (env: AppBindings) => ObjectStore;
  /** Defaults to the IMAGE_TO_AR Workflow binding; Node tests run conversions inline (ADR-023). */
  conversionRunner?: (env: AppBindings) => ConversionRunner;
}

/** Runtime bindings, generated from apps/web/wrangler.jsonc by `npm run cf-typegen -w @ar-creator/web`. */
export type AppBindings = Env;
export type AppEnv = { Bindings: AppBindings; Variables: { requestId: string; db: () => Promise<DbHandle>; authConfig: AuthConfig; auth: () => Promise<Auth>; user: SessionUser; assetStore: () => ObjectStore; conversions: () => ConversionRunner } };

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

/**
 * Better Auth returns the session token in JSON bodies (for bearer-token clients). This app authenticates only
 * with the HttpOnly cookie on one origin, so tokens are removed from bodies: script on the page (e.g. via an XSS
 * bug) must never be able to read a session token. Set-Cookie headers are untouched.
 */
export async function stripSessionTokens(res: Response): Promise<Response> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return res;
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, res);
  }
  const scrub = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'token').map(([k, x]) => [k, scrub(x)]));
    }
    return v;
  };
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(scrub(body)), { status: res.status, statusText: res.statusText, headers });
}

/** The Image-to-AR Workflow; starting a conversion fails (503) when the binding is missing. */
const defaultConversionRunner = (env: AppBindings): ConversionRunner => {
  const wf = (env as Partial<{ IMAGE_TO_AR: AppBindings['IMAGE_TO_AR'] }> | undefined)?.IMAGE_TO_AR;
  if (!wf) throw new Error('IMAGE_TO_AR workflow binding is missing');
  return workflowRunner(wf);
};

/** R2 via the ASSETS_BUCKET binding; fails closed (503) when the binding is missing. */
const defaultObjectStore = (env: AppBindings): ObjectStore => {
  const bucket = (env as Partial<{ ASSETS_BUCKET: R2Bucket }> | undefined)?.ASSETS_BUCKET;
  if (!bucket) throw new StorageUnavailableError('ASSETS_BUCKET binding is missing');
  return r2Store(bucket);
};

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
  app.use('*', authContext(deps.mailer ? { mailer: deps.mailer } : {}));
  app.use('*', sameOriginMutations);
  app.use('*', async (c, next) => {
    c.set('assetStore', () => (deps.objectStore ?? defaultObjectStore)(c.env));
    c.set('conversions', () => (deps.conversionRunner ?? defaultConversionRunner)(c.env));
    await next();
  });
  // Generated AR files are fetched by native viewers (Scene Viewer, Quick Look) from another origin. The signed,
  // cookieless URL is the only credential, so allowing cross-origin reads exposes nothing a URL holder cannot already
  // fetch. Registered before secureHeaders so its post-processing runs last and replaces the same-origin default.
  app.use('/derivatives/:id/content', async (c, next) => {
    await next();
    if (c.res.status === 200) {
      c.res.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      c.res.headers.set('Access-Control-Allow-Origin', '*');
    }
  });
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
    // Default for every API response; signed asset reads set their own private, short-lived policy.
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
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

  app.get('/auth-config', (c) => {
    const cfg = c.get('authConfig');
    return c.json(AuthConfigResponse.parse({ signupEnabled: cfg.signupEnabled, emailVerificationRequired: true, passwordMinLength: PASSWORD_MIN_LENGTH, passwordMaxLength: PASSWORD_MAX_LENGTH }));
  });

  app.on(['GET', 'POST'], '/auth/*', async (c) => {
    const cfg = c.get('authConfig');
    if (!cfg.ok) return apiError(c, 503, 'unavailable', 'Sign-in is temporarily unavailable.');
    const authPath = c.req.path.slice('/api/auth'.length);
    if (!isAllowedAuthRoute(c.req.method, authPath)) return apiError(c, 404, 'not_found', 'No such API route.');
    if (authPath === '/sign-up/email' && !cfg.signupEnabled) return apiError(c, 403, 'forbidden', 'Sign-up is not open yet.');
    const badParam = await unsafeRedirectIn(c.req.raw);
    if (badParam) return apiError(c, 400, 'bad_request', `${badParam} must be a path on this site.`);
    const auth = await c.get('auth')();
    const res = await auth.handler(c.req.raw);
    if (redirectsOffOrigin(res, cfg.baseURL ?? new URL(c.req.url).origin)) {
      logError(c, 'auth.offsite-redirect-blocked', res.headers.get('location') ?? '');
      return apiError(c, 400, 'bad_request', 'Redirect target refused.');
    }
    return stripSessionTokens(res);
  });

  app.get('/me', requireSession, (c) => c.json(MeResponse.parse({ user: c.get('user') })));

  // Experience management (Milestone 4, ADR-021): session required, ownership enforced in SQL.
  app.route('/experiences', experienceRoutes());
  // Asset storage (Milestone 5, ADR-022): uploads, listing, deletion (session) and signed private reads.
  app.route('/assets', assetRoutes());
  app.route('/', conversionRoutes());

  /** Public session probe for the UI: 200 with the user or null (no 401 noise for signed-out visitors). */
  app.get('/session', async (c) => {
    const auth = await c.get('auth')();
    const r = await auth.api.getSession({ headers: c.req.raw.headers });
    const user = r ? { id: r.user.id, email: r.user.email, name: r.user.name, emailVerified: r.user.emailVerified } : null;
    return c.json(SessionResponse.parse({ user }));
  });

  // Local development only (ADR-019): 404 unless APP_ENV=development, dev-mailbox transport and a localhost host.
  app.get('/dev/mailbox', (c) => {
    const cfg = c.get('authConfig');
    const host = new URL(c.req.url).hostname;
    if (cfg.environment !== 'development' || cfg.email.transport !== 'dev-mailbox' || !['localhost', '127.0.0.1'].includes(host)) {
      return apiError(c, 404, 'not_found', 'No such API route.');
    }
    return c.json({ messages: DevMailbox.list(c.req.query('to') ?? undefined) });
  });

  app.notFound((c) => apiError(c, 404, 'not_found', 'No such API route.'));
  app.onError((err, c) => {
    // Structured, redacted log for Workers Observability; responses never leak internals.
    if (err instanceof AuthUnavailableError) return apiError(c, 503, 'unavailable', 'Sign-in is temporarily unavailable.');
    if (err instanceof StorageUnavailableError) {
      logError(c, 'assets.storage-unavailable', err.message);
      return apiError(c, 503, 'unavailable', 'File storage is temporarily unavailable.');
    }
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

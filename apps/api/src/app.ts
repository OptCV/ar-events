import { Hono, type Context } from 'hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { HealthResponse, type ApiError, type ApiErrorCode } from '@ar-creator/contracts';

export interface BuildInfo {
  version: string;
  build: string;
}

/** Runtime bindings, generated from apps/web/wrangler.jsonc by `npm run cf-typegen -w @ar-creator/web`. */
export type AppBindings = Env;
export type AppEnv = { Bindings: AppBindings; Variables: { requestId: string } };

function detectRuntime(): HealthResponse['runtime'] {
  // workerd sets this exact UA (https://developers.cloudflare.com/workers/runtime-apis/web-standards/#navigatoruseragent).
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers' ? 'workerd' : 'other';
}

export function apiError(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 405 | 500, code: ApiErrorCode, message: string) {
  const body: ApiError = { error: { code, message, requestId: c.get('requestId') } };
  return c.json(body, status);
}

/**
 * The API is mounted under /api. In the deployed Worker, Workers Static Assets serves the SPA and only
 * `/api/*` reaches this code (`assets.run_worker_first`, ADR-014).
 */
export function createApp(info: BuildInfo) {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', requestId());
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

  app.get('/health', (c) => {
    const body = HealthResponse.parse({
      status: 'ok',
      service: 'ar-creator',
      version: info.version,
      build: info.build,
      runtime: detectRuntime(),
      time: new Date().toISOString(),
    });
    return c.json(body);
  });

  app.notFound((c) => apiError(c, 404, 'not_found', 'No such API route.'));
  app.onError((err, c) => {
    // Structured log for Workers Observability; response never leaks internals.
    console.error(JSON.stringify({ level: 'error', requestId: c.get('requestId'), path: c.req.path, message: err.message }));
    return apiError(c, 500, 'internal', 'Something went wrong. Please try again.');
  });

  return app;
}

export type App = ReturnType<typeof createApp>;

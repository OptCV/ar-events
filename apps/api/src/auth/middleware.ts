import type { Context, MiddlewareHandler } from 'hono';
import type { SessionUser } from '@ar-creator/contracts';
import type { AppEnv } from '../app.ts';
import { DevMailbox, DisabledMailer, ResendMailer, type Mailer } from '../email/mailer.ts';
import { createAuth, type Auth } from './auth.ts';
import { resolveAuthConfig, type AuthConfig, type RawAuthEnv } from './config.ts';

/** Better Auth paths the API exposes (everything else under /api/auth is 404). Method-specific. */
const ALLOWED: Record<string, readonly string[]> = {
  '/sign-up/email': ['POST'],
  '/sign-in/email': ['POST'],
  '/sign-out': ['POST'],
  '/get-session': ['GET'],
  '/send-verification-email': ['POST'],
  '/verify-email': ['GET'],
  '/request-password-reset': ['POST'],
  '/reset-password': ['POST'],
  '/revoke-sessions': ['POST'],
};
export function isAllowedAuthRoute(method: string, authPath: string): boolean {
  if (method === 'GET' && /^\/reset-password\/[A-Za-z0-9_-]{8,200}$/.test(authPath)) return true; // email link → redirect
  return ALLOWED[authPath]?.includes(method) ?? false;
}

let loggedProblems = '';
function logProblemsOnce(cfg: AuthConfig) {
  const key = cfg.problems.join('|');
  if (key && key !== loggedProblems) {
    loggedProblems = key;
    console.warn(JSON.stringify({ level: 'warn', event: 'auth.config', problems: cfg.problems }));
  }
}

export function mailerFor(cfg: AuthConfig): Mailer {
  if (cfg.email.transport === 'resend') return new ResendMailer(cfg.email.apiKey, cfg.email.from);
  if (cfg.email.transport === 'dev-mailbox') return new DevMailbox();
  return new DisabledMailer();
}

export class AuthUnavailableError extends Error {
  override name = 'AuthUnavailableError';
}

/** Resolves config per request and exposes a lazy, per-request Better Auth instance bound to the request's DB connection. */
export function authContext(opts: { mailer?: (cfg: AuthConfig) => Mailer } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cfg = resolveAuthConfig((c.env ?? {}) as unknown as RawAuthEnv); // no env (unit tests) → fail closed
    logProblemsOnce(cfg);
    c.set('authConfig', cfg);
    let instance: Promise<Auth> | null = null;
    c.set('auth', () => {
      if (!cfg.ok) return Promise.reject(new AuthUnavailableError('authentication is not configured'));
      return (instance ??= (async () => {
        const { db } = await c.get('db')();
        const origin = cfg.baseURL ?? new URL(c.req.url).origin; // inference only possible in development (config rules)
        return createAuth({ db, config: cfg, mailer: (opts.mailer ?? mailerFor)(cfg), origin, waitUntil: waitUntilOf(c) });
      })());
    });
    await next();
  };
}

function waitUntilOf(c: Context<AppEnv>): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return undefined;
  }
}

/** Protect a route: 401 JSON unless a valid, unexpired, unrevoked session exists (read from the DB every time). */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = await c.get('auth')();
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) {
    return c.json({ error: { code: 'unauthorized', message: 'Sign in to continue.', requestId: c.get('requestId') } }, 401);
  }
  const u = result.user;
  const user: SessionUser = { id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerified };
  c.set('user', user);
  await next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BINARY_UPLOAD_PATH = /^\/api\/assets\/[0-9a-f-]{36}\/content$/i;
/**
 * CSRF defence for EVERY state-changing API request, including /api/auth/* (ADR-019 finding: Better Auth's own
 * origin check only applies to cookie-bearing requests, so a cookieless cross-site sign-in — login CSRF — was
 * accepted). Requires an Origin header equal to the app origin and a JSON body type. SameSite=Lax is the first layer.
 */
export const sameOriginMutations: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const cfg = c.get('authConfig');
  const expected = cfg.baseURL ?? new URL(c.req.url).origin;
  const origin = c.req.header('origin');
  const type = c.req.header('content-type') ?? '';
  // Body-carrying methods must be JSON (blocks form-encoded cross-site posts). DELETE has no body: Origin suffices
  // (HTML forms cannot send DELETE and cross-origin fetch DELETE requires a CORS preflight we never grant).
  // The binary upload route (ADR-022) is the single exception to the JSON rule: its body IS the file. The Origin
  // check still applies, and a cross-site PUT is impossible without a CORS preflight we never grant.
  const binaryUpload = c.req.method === 'PUT' && BINARY_UPLOAD_PATH.test(c.req.path);
  const needsJson = !binaryUpload && (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH');
  if (origin !== expected || (needsJson && !type.toLowerCase().startsWith('application/json'))) {
    return c.json({ error: { code: 'forbidden', message: 'Cross-origin or non-JSON request refused.', requestId: c.get('requestId') } }, 403);
  }
  return next();
};

/** Parameters Better Auth uses to redirect the browser after an email link or a flow completes. */
export const REDIRECT_PARAMS = ['callbackURL', 'redirectTo', 'newUserCallbackURL', 'errorCallbackURL'] as const;

/** Same-origin relative path only: "/x", never "//host", "/\host", absolute URLs or control characters. */
export function isSafeRedirect(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  // Browsers treat "\" like "/" in URLs, so "/\host" is protocol-relative too.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Open-redirect / token-leak defence (ADR-019 finding): with Better Auth 1.7.16 an attacker could request a
 * password reset for a victim with redirectTo=https://evil.example and the genuine email link then redirected the
 * victim's browser there WITH the reset token. We reject foreign redirect targets in request bodies and email-link
 * query strings, and refuse any auth response that redirects off-origin.
 */
export async function unsafeRedirectIn(req: Request): Promise<string | null> {
  const url = new URL(req.url);
  for (const k of REDIRECT_PARAMS) {
    const v = url.searchParams.get(k);
    if (v !== null && !isSafeRedirect(v)) return k;
  }
  if (req.method === 'POST' && (req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    const body = (await req.clone().json().catch(() => null)) as Record<string, unknown> | null;
    if (body && typeof body === 'object') {
      for (const k of REDIRECT_PARAMS) if (k in body && body[k] !== undefined && !isSafeRedirect(body[k])) return k;
    }
  }
  return null;
}

export function redirectsOffOrigin(res: Response, origin: string): boolean {
  const loc = res.headers.get('location');
  if (!loc) return false;
  try {
    return new URL(loc, origin).origin !== origin;
  } catch {
    return true;
  }
}

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ar-creator/contracts';
import { schema, type Database } from '@ar-creator/db';
import type { Mailer } from '../email/mailer.ts';
import { assertOwnOrigin, buildEmail } from '../email/templates.ts';
import type { AuthConfig } from './config.ts';

export const COOKIE_PREFIX = 'arc';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24; // refresh expiry at most daily
export const EMAIL_TOKEN_TTL_SECONDS = 60 * 60; // verification + reset links: 1 hour

/** Per-path limits (per client IP, CF-Connecting-IP), stored in Postgres (memory is per-isolate; KV unsuitable). */
export const RATE_LIMITS = {
  window: 60,
  max: 60,
  customRules: {
    '/sign-in/email': { window: 60, max: 5 },
    '/sign-up/email': { window: 60 * 60, max: 5 },
    '/request-password-reset': { window: 15 * 60, max: 3 },
    '/send-verification-email': { window: 15 * 60, max: 3 },
    '/reset-password': { window: 15 * 60, max: 5 },
  },
} as const;

export interface CreateAuthOptions {
  db: Database;
  config: AuthConfig;
  mailer: Mailer;
  /** Effective origin: config.baseURL, or (development only) the request origin. */
  origin: string;
  /** ctx.waitUntil when available, so slow email delivery does not block or reveal timing. */
  waitUntil?: ((p: Promise<unknown>) => void) | undefined;
}

/**
 * Better Auth instance for ONE request (ADR-013): bound to that request's pg connection, never module-scoped.
 * Sessions are always read from the database (cookie cache off), so sign-out and revocation take effect
 * immediately; Hyperdrive caching is disabled for the same reason.
 */
export function createAuth({ db, config, mailer, origin, waitUntil }: CreateAuthOptions) {
  const send = async (kind: 'verify-email' | 'reset-password', to: string, url: string, key: string) => {
    await mailer.send(buildEmail(kind, to, assertOwnOrigin(url, origin), key));
  };

  return betterAuth({
    appName: 'AR Creator',
    secret: config.secret,
    baseURL: origin,
    basePath: '/api/auth',
    trustedOrigins: [origin],
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.signupEnabled,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      resetPasswordTokenExpiresIn: EMAIL_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }) => send('reset-password', user.email, url, `reset:${token}`),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: EMAIL_TOKEN_TTL_SECONDS,
      sendVerificationEmail: async ({ user, url, token }) => send('verify-email', user.email, url, `verify:${token}`),
    },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: 'database', ...RATE_LIMITS },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      ...(waitUntil ? { backgroundTasks: { handler: waitUntil } } : {}),
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

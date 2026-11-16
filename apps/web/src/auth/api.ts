import { AuthConfigResponse, SessionResponse, type SessionUser } from '@ar-creator/contracts';
import { getJson } from '../api/client.ts';

/** User-facing auth error. `code` mirrors Better Auth / API codes; `retryAfter` is set for 429. */
export class AuthError extends Error {
  override name = 'AuthError';
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number | null;
  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const FRIENDLY: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'That email and password combination is not correct.',
  EMAIL_NOT_VERIFIED: 'Confirm your email address first. We have sent you a new confirmation link.',
  INVALID_TOKEN: 'This link is invalid or has expired. Request a new one.',
  PASSWORD_TOO_SHORT: 'That password is too short.',
  PASSWORD_TOO_LONG: 'That password is too long.',
  forbidden: 'This action is not allowed.',
  unavailable: 'Sign-in is temporarily unavailable. Please try again in a moment.',
};

async function post(path: `/api/auth/${string}`, body: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  const data = (await res.json().catch(() => null)) as { code?: string; message?: string; error?: { code?: string; message?: string } } | null;
  if (res.ok) return data;
  if (res.status === 429) {
    const retry = Number(res.headers.get('x-retry-after') ?? res.headers.get('retry-after') ?? '60') || 60;
    throw new AuthError(429, 'rate_limited', `Too many attempts. Try again in ${retry} seconds.`, retry);
  }
  const code = data?.code ?? data?.error?.code ?? `http_${res.status}`;
  const message = FRIENDLY[code] ?? data?.error?.message ?? 'Something went wrong. Please try again.';
  throw new AuthError(res.status, code, message);
}

export const authApi = {
  config: () => getJson('/api/auth-config', AuthConfigResponse),

  /** Current user, or null when signed out. Always asks the server (sessions are revocable). */
  async me(): Promise<SessionUser | null> {
    const res = await fetch('/api/session', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) throw new AuthError(res.status, res.status === 503 ? 'unavailable' : 'http', FRIENDLY.unavailable!);
    return SessionResponse.parse(await res.json()).user;
  },

  signUp: (v: { name: string; email: string; password: string }) => post('/api/auth/sign-up/email', { ...v, callbackURL: '/email-verified' }),
  signIn: (v: { email: string; password: string }) => post('/api/auth/sign-in/email', { ...v, callbackURL: '/email-verified' }),
  signOut: () => post('/api/auth/sign-out', {}),
  signOutEverywhere: () => post('/api/auth/revoke-sessions', {}),
  resendVerification: (email: string) => post('/api/auth/send-verification-email', { email, callbackURL: '/email-verified' }),
  requestPasswordReset: (email: string) => post('/api/auth/request-password-reset', { email, redirectTo: '/reset-password' }),
  resetPassword: (token: string, newPassword: string) => post('/api/auth/reset-password', { token, newPassword }),
};

/** Post-login destination: same-site path only (never "//host" or absolute URLs). */
export function safeNext(next: string | null, fallback = '/dashboard'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}

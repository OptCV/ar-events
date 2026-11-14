/**
 * Authentication configuration, resolved from Worker vars/secrets with FAIL-CLOSED defaults (ADR-019):
 *   - APP_ENV defaults to "production" unless explicitly "development".
 *   - Missing/short BETTER_AUTH_SECRET, or a non-https BETTER_AUTH_URL in production → auth disabled (503).
 *   - Email: "resend" needs RESEND_API_KEY + EMAIL_FROM; "dev-mailbox" is only allowed in development.
 *   - Public sign-up requires AUTH_SIGNUP_ENABLED="true" AND working email delivery.
 * Values are never logged; `problems` are human-readable and safe to log.
 */
export interface RawAuthEnv {
  APP_ENV?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  AUTH_SIGNUP_ENABLED?: string;
  EMAIL_TRANSPORT?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
}

export type EmailConfig =
  | { transport: 'resend'; apiKey: string; from: string }
  | { transport: 'dev-mailbox'; from: string }
  | { transport: 'disabled' };

export interface AuthConfig {
  /** false → every auth endpoint answers 503; nothing is attempted. */
  ok: boolean;
  environment: 'development' | 'production';
  secret: string;
  /** null = infer from the request origin (development only). */
  baseURL: string | null;
  secureCookies: boolean;
  signupEnabled: boolean;
  email: EmailConfig;
  problems: string[];
}

export const MIN_SECRET_LENGTH = 32;
const FROM = /^[^<>\r\n]{0,80}<[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>$|^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

export function resolveAuthConfig(env: RawAuthEnv): AuthConfig {
  const problems: string[] = [];
  const environment = env.APP_ENV === 'development' ? 'development' : 'production';
  let ok = true;

  const secret = env.BETTER_AUTH_SECRET ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    ok = false;
    problems.push(`BETTER_AUTH_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters`);
  }

  let baseURL: string | null = null;
  if (env.BETTER_AUTH_URL) {
    try {
      const u = new URL(env.BETTER_AUTH_URL);
      if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('not an origin');
      if (environment === 'production' && u.protocol !== 'https:') {
        ok = false;
        problems.push('BETTER_AUTH_URL must use https in production');
      }
      baseURL = u.origin;
    } catch {
      ok = false;
      problems.push('BETTER_AUTH_URL must be an origin such as https://ar.example.com');
    }
  } else if (environment === 'production') {
    ok = false;
    problems.push('BETTER_AUTH_URL is required in production');
  }
  const secureCookies = baseURL ? baseURL.startsWith('https:') : false;

  let email: EmailConfig = { transport: 'disabled' };
  const from = env.EMAIL_FROM?.trim() ?? '';
  const transport = env.EMAIL_TRANSPORT ?? 'resend';
  if (transport === 'dev-mailbox') {
    if (environment === 'development') email = { transport: 'dev-mailbox', from: from || 'AR Creator <dev@localhost.invalid>' };
    else problems.push('EMAIL_TRANSPORT=dev-mailbox is not allowed outside development');
  } else if (transport === 'resend') {
    if (!env.RESEND_API_KEY) problems.push('RESEND_API_KEY is not set');
    else if (!FROM.test(from)) problems.push('EMAIL_FROM must be "Name <address@verified-domain>"');
    else email = { transport: 'resend', apiKey: env.RESEND_API_KEY, from };
  } else {
    problems.push(`unknown EMAIL_TRANSPORT "${transport}"`);
  }

  const signupRequested = env.AUTH_SIGNUP_ENABLED === 'true';
  const signupEnabled = signupRequested && ok && email.transport !== 'disabled';
  if (signupRequested && !signupEnabled) problems.push('AUTH_SIGNUP_ENABLED=true ignored: authentication or email delivery is not fully configured');

  return { ok, environment, secret, baseURL, secureCookies, signupEnabled, email, problems };
}

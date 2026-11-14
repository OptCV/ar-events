import { describe, expect, it } from 'vitest';
import { resolveAuthConfig } from './config.ts';
import { isAllowedAuthRoute, isSafeRedirect } from './middleware.ts';
import { EmailDeliveryError, ResendMailer } from '../email/mailer.ts';
import { assertOwnOrigin, buildEmail } from '../email/templates.ts';

const SECRET = 'x'.repeat(48);

describe('resolveAuthConfig (fail closed)', () => {
  it('defaults to production and refuses to run without a secret and an https origin', () => {
    const c = resolveAuthConfig({});
    expect(c).toMatchObject({ ok: false, environment: 'production', signupEnabled: false });
    expect(c.problems.join(' ')).toMatch(/BETTER_AUTH_SECRET/);
    expect(c.problems.join(' ')).toMatch(/BETTER_AUTH_URL is required/);
  });

  it('rejects short secrets, http origins in production and URLs with paths', () => {
    expect(resolveAuthConfig({ BETTER_AUTH_SECRET: 'short', BETTER_AUTH_URL: 'https://a.test' }).ok).toBe(false);
    expect(resolveAuthConfig({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'http://a.test' }).ok).toBe(false);
    expect(resolveAuthConfig({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'https://a.test/app' }).ok).toBe(false);
  });

  it('production with Resend configured: secure cookies, sign-up only when explicitly enabled', () => {
    const base = { BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'https://ar.example.com', RESEND_API_KEY: 're_x', EMAIL_FROM: 'AR Creator <no-reply@example.com>' };
    expect(resolveAuthConfig(base)).toMatchObject({ ok: true, secureCookies: true, signupEnabled: false, email: { transport: 'resend' } });
    expect(resolveAuthConfig({ ...base, AUTH_SIGNUP_ENABLED: 'true' }).signupEnabled).toBe(true);
    expect(resolveAuthConfig({ ...base, AUTH_SIGNUP_ENABLED: 'yes' }).signupEnabled).toBe(false);
  });

  it('sign-up stays closed when email is not deliverable', () => {
    const prod = { BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'https://ar.example.com', AUTH_SIGNUP_ENABLED: 'true' };
    expect(resolveAuthConfig(prod).signupEnabled).toBe(false); // no RESEND_API_KEY
    expect(resolveAuthConfig({ ...prod, RESEND_API_KEY: 're_x', EMAIL_FROM: 'not an address' }).signupEnabled).toBe(false);
    expect(resolveAuthConfig({ ...prod, EMAIL_TRANSPORT: 'dev-mailbox' })).toMatchObject({ signupEnabled: false, email: { transport: 'disabled' } });
  });

  it('development: origin inferred, dev mailbox allowed, never Secure cookies on http', () => {
    const c = resolveAuthConfig({ APP_ENV: 'development', BETTER_AUTH_SECRET: SECRET, EMAIL_TRANSPORT: 'dev-mailbox', AUTH_SIGNUP_ENABLED: 'true' });
    expect(c).toMatchObject({ ok: true, baseURL: null, secureCookies: false, signupEnabled: true, email: { transport: 'dev-mailbox' } });
  });

  it('problems never contain secret values', () => {
    const c = resolveAuthConfig({ BETTER_AUTH_SECRET: 'tiny-secret', RESEND_API_KEY: 're_supersecret', BETTER_AUTH_URL: 'http://x.test' });
    expect(c.problems.join(' ')).not.toMatch(/tiny-secret|re_supersecret/);
  });
});

describe('isSafeRedirect', () => {
  it.each([
    ['/reset-password', true],
    ['/email-verified?x=1', true],
    ['https://evil.example', false],
    ['//evil.example', false],
    ['/\\evil.example', false],
    ['javascript:alert(1)', false],
    ['', false],
    ['/a\nb', false],
    [`/${'a'.repeat(600)}`, false],
    [42, false],
  ])('%s → %s', (v, ok) => expect(isSafeRedirect(v)).toBe(ok));
});

describe('isAllowedAuthRoute', () => {
  it('allows only the endpoints the app uses, with the right method', () => {
    expect(isAllowedAuthRoute('POST', '/sign-in/email')).toBe(true);
    expect(isAllowedAuthRoute('GET', '/sign-in/email')).toBe(false);
    expect(isAllowedAuthRoute('GET', '/reset-password/abcdefgh12345')).toBe(true);
    expect(isAllowedAuthRoute('GET', '/reset-password/../admin')).toBe(false);
    expect(isAllowedAuthRoute('POST', '/delete-user')).toBe(false);
  });
});

describe('ResendMailer', () => {
  const email = buildEmail('verify-email', 'a@example.com', 'https://ar.example.com/api/auth/verify-email?token=t', 'verify:t');

  it('posts to the Resend API with bearer auth, idempotency key and both bodies', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await new ResendMailer('re_key_123', 'AR Creator <no-reply@example.com>', fake).send(email);
    expect(seen!.url).toBe('https://api.resend.com/emails');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_key_123');
    expect(headers['idempotency-key']).toBe('verify:t');
    const body = JSON.parse(String(seen!.init.body));
    expect(body).toMatchObject({ from: 'AR Creator <no-reply@example.com>', to: ['a@example.com'], subject: email.subject });
    expect(body.html).toContain('Confirm email');
    expect(body.text).toContain('https://ar.example.com/api/auth/verify-email?token=t');
  });

  it('errors are typed and never contain the API key', async () => {
    const fake = (async () => new Response(JSON.stringify({ name: 'validation_error', message: 'bad from' }), { status: 422 })) as unknown as typeof fetch;
    const err = await new ResendMailer('re_key_SECRET', 'x <a@b.co>', fake).send(email).catch((e) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(err.status).toBe(422);
    expect(String(err.message)).not.toContain('re_key_SECRET');
  });
});

describe('email templates', () => {
  it('escape HTML and refuse foreign-origin links', () => {
    const e = buildEmail('reset-password', 'a@example.com', 'https://ar.example.com/x?a=<b>', 'k');
    expect(e.html).not.toContain('<b>');
    expect(() => assertOwnOrigin('https://evil.example/x', 'https://ar.example.com')).toThrow();
    expect(assertOwnOrigin('https://ar.example.com/x', 'https://ar.example.com')).toBe('https://ar.example.com/x');
  });
});

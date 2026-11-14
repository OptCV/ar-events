/**
 * Milestone 3 authentication — integration tests: full Hono app + Better Auth 1.7.16 + Drizzle + LOCAL Docker
 * Postgres (fresh migrated database per file). Emails are captured by an injected mailer (no Resend needed).
 * Run: npm run test:integration   (requires `npm run db:up`)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, AuthConfigResponse, MeResponse, SessionResponse } from '@ar-creator/contracts';
import { DatabaseError } from '@ar-creator/db';
import { createTempDatabase, migrateDatabase } from '../../../packages/db/test/helpers.ts';
import { Jar, PASSWORD, linkIn, makeHarness, uniqueEmail, type Harness } from './harness.ts';

let temp: Awaited<ReturnType<typeof createTempDatabase>>;
let h: Harness;

beforeAll(async () => {
  temp = await createTempDatabase();
  await migrateDatabase(temp.url);
  h = makeHarness({ dbUrl: temp.url });
});
afterAll(async () => temp?.drop());

const path = (link: string) => link.replace(/^https?:\/\/[^/]+/, '');

async function signUp(email = uniqueEmail(), name = 'Creator') {
  const before = h.mails.length;
  const res = await h.req('/api/auth/sign-up/email', { body: { name, email, password: PASSWORD, callbackURL: '/email-verified' } });
  return { email, res, mail: h.mails.slice(before).find((m) => m.to === email) };
}

async function verifiedUser() {
  const { email, mail } = await signUp();
  const r = await h.req(path(linkIn(mail)));
  expect(r.status).toBe(302);
  return email;
}

async function signIn(email: string, password = PASSWORD, jar = new Jar(), ip?: string) {
  const res = await h.req('/api/auth/sign-in/email', { body: { email, password }, jar, ...(ip ? { ip } : {}) });
  return { res, jar };
}

describe('configuration', () => {
  it('GET /api/auth-config reports sign-up enabled locally (dev mailbox) with the password policy', async () => {
    const body = AuthConfigResponse.parse(await (await h.req('/api/auth-config')).json());
    expect(body).toEqual({ signupEnabled: true, emailVerificationRequired: true, passwordMinLength: 12, passwordMaxLength: 128 });
  });

  it('sign-up is refused (403) and advertised as closed when AUTH_SIGNUP_ENABLED is not "true"', async () => {
    const closed = makeHarness({ dbUrl: temp.url, env: { AUTH_SIGNUP_ENABLED: 'false' } });
    expect(AuthConfigResponse.parse(await (await closed.req('/api/auth-config')).json()).signupEnabled).toBe(false);
    const r = await closed.req('/api/auth/sign-up/email', { body: { name: 'X', email: uniqueEmail(), password: PASSWORD } });
    expect(r.status).toBe(403);
    expect(ApiError.parse(await r.json()).error.code).toBe('forbidden');
    expect(closed.mails).toHaveLength(0);
  });

  it('production without email delivery keeps sign-up closed even if requested', async () => {
    const prod = makeHarness({
      dbUrl: temp.url,
      base: 'https://ar.example.test',
      env: { APP_ENV: 'production', BETTER_AUTH_URL: 'https://ar.example.test', EMAIL_TRANSPORT: 'dev-mailbox', AUTH_SIGNUP_ENABLED: 'true' },
    });
    expect(AuthConfigResponse.parse(await (await prod.req('/api/auth-config')).json()).signupEnabled).toBe(false);
  });

  it('missing secret → every auth endpoint and protected route answers 503 (fail closed)', async () => {
    const broken = makeHarness({ dbUrl: temp.url, env: { BETTER_AUTH_SECRET: '' } });
    for (const r of [
      await broken.req('/api/auth/sign-in/email', { body: { email: uniqueEmail(), password: PASSWORD } }),
      await broken.req('/api/auth/get-session'),
      await broken.req('/api/me'),
    ]) {
      expect(r.status).toBe(503);
      expect(ApiError.parse(await r.json()).error.code).toBe('unavailable');
    }
  });

  it('only allowlisted Better Auth endpoints are reachable', async () => {
    for (const [method, p] of [
      ['GET', '/api/auth/list-sessions'],
      ['POST', '/api/auth/change-email'],
      ['POST', '/api/auth/delete-user'],
      ['POST', '/api/auth/update-user'],
      ['GET', '/api/auth/sign-in/email'],
      ['POST', '/api/auth/admin/set-role'],
    ] as const) {
      const r = await h.req(p, { method, ...(method === 'POST' ? { body: {} } : {}) });
      expect(r.status, `${method} ${p}`).toBe(404);
    }
  });
});

describe('registration and email verification', () => {
  it('creates an unverified account, sets no session, and emails a verification link to our own origin', async () => {
    const { email, res, mail } = await signUp();
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(JSON.stringify(await res.json())).not.toMatch(/"token":/);
    const rows = await h.sql('SELECT email_verified FROM "user" WHERE email = $1', [email]);
    expect(rows.rows).toEqual([{ email_verified: false }]);
    expect(mail?.kind).toBe('verify-email');
    expect(linkIn(mail).startsWith(`${h.base}/api/auth/verify-email?token=`)).toBe(true);
  });

  it('rejects invalid input (short password, bad email)', async () => {
    expect((await h.req('/api/auth/sign-up/email', { body: { name: 'X', email: uniqueEmail(), password: 'short' } })).status).toBe(400);
    expect((await h.req('/api/auth/sign-up/email', { body: { name: 'X', email: 'not-an-email', password: PASSWORD } })).status).toBe(400);
    expect((await h.req('/api/auth/sign-up/email', { body: { name: 'X', email: uniqueEmail(), password: 'x'.repeat(129) } })).status).toBe(400);
  });

  it('duplicate sign-up is rejected without revealing that the account exists', async () => {
    const { email } = await signUp(uniqueEmail(), 'First');
    const mailsBefore = h.mails.length;
    const dup = await h.req('/api/auth/sign-up/email', { body: { name: 'Second', email, password: 'another password 12345' } });
    // Better Auth answers like a normal sign-up (anti-enumeration) but creates nothing and sends nothing.
    expect(dup.status).toBe(200);
    expect(dup.headers.getSetCookie()).toEqual([]);
    expect((await h.sql('SELECT name FROM "user" WHERE email = $1', [email])).rows).toEqual([{ name: 'First' }]);
    expect(h.mails.length).toBe(mailsBefore);
  });

  it('unverified accounts cannot sign in (403 EMAIL_NOT_VERIFIED) and a fresh verification email is sent', async () => {
    const { email } = await signUp();
    const before = h.mails.length;
    const { res, jar } = await signIn(email);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('EMAIL_NOT_VERIFIED');
    expect(jar.cookies.size).toBe(0);
    expect(h.mails.slice(before).some((m) => m.to === email && m.kind === 'verify-email')).toBe(true);
  });

  it('the verification link verifies the email and redirects to the app; a tampered token is rejected', async () => {
    const { email, mail } = await signUp();
    const link = linkIn(mail);
    const bad = await h.req(path(link).replace(/token=[^&]+/, 'token=eyJhbGciOiJIUzI1NiJ9.e30.invalid'));
    expect(bad.status).toBe(302);
    expect(bad.headers.get('location')).toMatch(/\/email-verified\?error=/);
    const ok = await h.req(path(link));
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/email-verified');
    expect((await h.sql('SELECT email_verified FROM "user" WHERE email = $1', [email])).rows).toEqual([{ email_verified: true }]);
  });
});

describe('sign-in, sessions, sign-out', () => {
  it('valid credentials → HttpOnly SameSite=Lax session cookie; token never in the body', async () => {
    const email = await verifiedUser();
    const { res, jar } = await signIn(email);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toMatch(/"token"/);
    const cookie = jar.raw.find((c) => c.startsWith('arc.session_token='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=604800/);
  });

  it('invalid credentials → identical 401 for wrong password and unknown email, no cookie', async () => {
    const email = await verifiedUser();
    const wrong = await signIn(email, 'wrong password 123', new Jar(), '192.0.2.10');
    const unknown = await signIn(uniqueEmail(), 'wrong password 123', new Jar(), '192.0.2.11');
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.status).toBe(401);
    expect(await wrong.res.json()).toEqual(await unknown.res.json());
    expect(wrong.jar.cookies.size + unknown.jar.cookies.size).toBe(0);
  });

  it('session persists across requests and is backed by a database row', async () => {
    const email = await verifiedUser();
    const { jar } = await signIn(email);
    for (let i = 0; i < 3; i++) {
      const me = await h.req('/api/me', { jar });
      expect(me.status).toBe(200);
      expect(MeResponse.parse(await me.json()).user).toMatchObject({ email, emailVerified: true });
    }
    const gs = await h.req('/api/auth/get-session', { jar });
    expect(gs.status).toBe(200);
    expect(JSON.stringify(await gs.json())).not.toMatch(/"token"/);
    const n = await h.sql('SELECT count(*)::int AS n FROM "session" s JOIN "user" u ON u.id = s.user_id WHERE u.email = $1', [email]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('GET /api/session (UI auth state): null when signed out, the user when signed in, null after sign-out', async () => {
    const parse = async (r: Response) => {
      expect(r.status).toBe(200);
      return SessionResponse.parse(await r.json()).user;
    };
    expect(await parse(await h.req('/api/session'))).toBeNull();
    const email = await verifiedUser();
    const { jar } = await signIn(email);
    expect(await parse(await h.req('/api/session', { jar }))).toMatchObject({ email, emailVerified: true });
    await h.req('/api/auth/sign-out', { body: {}, jar });
    expect(await parse(await h.req('/api/session', { jar }))).toBeNull();
  });

  it('an expired session is rejected', async () => {
    const email = await verifiedUser();
    const { jar } = await signIn(email);
    expect((await h.req('/api/me', { jar })).status).toBe(200);
    await h.sql(`UPDATE "session" SET expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM "user" WHERE email = $1)`, [email]);
    expect((await h.req('/api/me', { jar })).status).toBe(401);
  });

  it('sign-out deletes the session server-side: the old cookie no longer works', async () => {
    const email = await verifiedUser();
    const { jar } = await signIn(email);
    const stolen = jar.header(); // simulate a copied cookie
    expect((await h.req('/api/auth/sign-out', { body: {}, jar })).status).toBe(200);
    expect(jar.cookies.has('arc.session_token')).toBe(false);
    const replay = await h.req('/api/me', { headers: { cookie: stolen } });
    expect(replay.status).toBe(401);
    const n = await h.sql('SELECT count(*)::int AS n FROM "session" s JOIN "user" u ON u.id = s.user_id WHERE u.email = $1', [email]);
    expect(n.rows[0]!.n).toBe(0);
  });

  it('revoke-sessions signs out every device', async () => {
    const email = await verifiedUser();
    const a = await signIn(email);
    const b = await signIn(email);
    expect((await h.req('/api/me', { jar: b.jar })).status).toBe(200);
    expect((await h.req('/api/auth/revoke-sessions', { body: {}, jar: a.jar })).status).toBe(200);
    expect((await h.req('/api/me', { jar: b.jar })).status).toBe(401);
    expect((await h.req('/api/me', { jar: a.jar })).status).toBe(401);
  });

  it('production (https) cookies use the __Secure- prefix and the Secure attribute', async () => {
    const email = await verifiedUser();
    const prod = makeHarness({
      dbUrl: temp.url,
      base: 'https://ar.example.test',
      env: { APP_ENV: 'production', BETTER_AUTH_URL: 'https://ar.example.test', EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test_not_real', EMAIL_FROM: 'AR Creator <no-reply@example.test>', AUTH_SIGNUP_ENABLED: 'false' },
    });
    const jar = new Jar();
    const r = await prod.req('/api/auth/sign-in/email', { body: { email, password: PASSWORD }, jar });
    expect(r.status).toBe(200);
    const cookie = jar.raw.find((c) => c.startsWith('__Secure-arc.session_token='))!;
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await prod.req('/api/me', { jar })).status).toBe(200);
  });
});

describe('protected routes and unauthorized access', () => {
  it('no cookie, a forged cookie, or a malformed cookie → 401 JSON', async () => {
    for (const cookie of [undefined, 'arc.session_token=forged.value', 'arc.session_token=', 'garbage']) {
      const r = await h.req('/api/me', cookie ? { headers: { cookie } } : {});
      expect(r.status, String(cookie)).toBe(401);
      expect(ApiError.parse(await r.json()).error.code).toBe('unauthorized');
    }
  });

  it('REGRESSION (login CSRF): cross-origin, origin-less and non-JSON auth POSTs are refused before any session is created', async () => {
    const email = await verifiedUser();
    const attempts = [
      await h.req('/api/auth/sign-in/email', { body: { email, password: PASSWORD }, origin: 'https://evil.example' }),
      await h.req('/api/auth/sign-in/email', { body: { email, password: PASSWORD }, origin: null }),
      await h.req('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    ];
    for (const r of attempts) {
      expect(r.status).toBe(403);
      expect(r.headers.getSetCookie()).toEqual([]);
    }
    const n = await h.sql('SELECT count(*)::int AS n FROM "session" s JOIN "user" u ON u.id = s.user_id WHERE u.email = $1', [email]);
    expect(n.rows[0]!.n).toBe(0);
  });

  it('the dev mailbox endpoint is 404 outside local development', async () => {
    const prod = makeHarness({ dbUrl: temp.url, base: 'https://ar.example.test', env: { APP_ENV: 'production', BETTER_AUTH_URL: 'https://ar.example.test' } });
    expect((await prod.req('/api/dev/mailbox')).status).toBe(404);
    const devButRemoteHost = makeHarness({ dbUrl: temp.url, base: 'http://ar.example.test' });
    expect((await devButRemoteHost.req('/api/dev/mailbox')).status).toBe(404);
  });
});

describe('password reset', () => {
  it('request → email link → reset → old sessions revoked → only the new password works; token single-use', async () => {
    const email = await verifiedUser();
    const old = await signIn(email);
    const before = h.mails.length;
    const req = await h.req('/api/auth/request-password-reset', { body: { email, redirectTo: '/reset-password' } });
    expect(req.status).toBe(200);
    const mail = h.mails.slice(before).find((m) => m.to === email && m.kind === 'reset-password');
    const link = linkIn(mail);
    expect(link.startsWith(`${h.base}/api/auth/reset-password/`)).toBe(true);

    const landing = await h.req(path(link));
    expect(landing.status).toBe(302);
    const target = new URL(landing.headers.get('location')!, h.base);
    expect(target.pathname).toBe('/reset-password');
    const token = target.searchParams.get('token')!;
    expect(token).toBeTruthy();

    const newPassword = 'a completely new passphrase';
    expect((await h.req('/api/auth/reset-password', { body: { newPassword, token } })).status).toBe(200);
    expect((await h.req('/api/me', { jar: old.jar })).status).toBe(401); // revokeSessionsOnPasswordReset
    expect((await signIn(email, PASSWORD, new Jar(), '192.0.2.60')).res.status).toBe(401);
    expect((await signIn(email, newPassword, new Jar(), '192.0.2.61')).res.status).toBe(200);
    expect((await h.req('/api/auth/reset-password', { body: { newPassword: 'yet another passphrase!', token } })).status).toBe(400);
  });

  it('unknown emails get the same response and no email (no enumeration)', async () => {
    const before = h.mails.length;
    const known = await verifiedUser();
    const afterSignup = h.mails.length;
    const a = await h.req('/api/auth/request-password-reset', { body: { email: known, redirectTo: '/reset-password' }, ip: '192.0.2.70' });
    const b = await h.req('/api/auth/request-password-reset', { body: { email: uniqueEmail(), redirectTo: '/reset-password' }, ip: '192.0.2.71' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    expect(h.mails.length - afterSignup).toBe(1);
    expect(afterSignup).toBeGreaterThan(before);
  });

  it('REGRESSION (token leak): a foreign redirectTo is refused, so no reset email can bounce the token off-site', async () => {
    const email = await verifiedUser();
    const before = h.mails.length;
    for (const redirectTo of ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example', 'javascript:alert(1)']) {
      const r = await h.req('/api/auth/request-password-reset', { body: { email, redirectTo } });
      expect(r.status, redirectTo).toBe(400);
      expect(ApiError.parse(await r.json()).error.code).toBe('bad_request');
    }
    expect(h.mails.length).toBe(before); // nothing was emailed
  });

  it('REGRESSION: a tampered email link with a foreign callbackURL is refused before Better Auth runs', async () => {
    const email = await verifiedUser();
    await h.req('/api/auth/request-password-reset', { body: { email, redirectTo: '/reset-password' } });
    const link = path(linkIn(h.mails.at(-1)));
    const tampered = link.replace(/callbackURL=[^&]+/, `callbackURL=${encodeURIComponent('https://evil.example/steal')}`);
    const r = await h.req(tampered);
    expect(r.status).toBe(400);
    expect(r.headers.get('location')).toBeNull();
  });

  it('REGRESSION: sign-up / verification with a foreign callbackURL is refused (open redirect)', async () => {
    const r = await h.req('/api/auth/sign-up/email', { body: { name: 'X', email: uniqueEmail(), password: PASSWORD, callbackURL: 'https://evil.example/cb' } });
    expect(r.status).toBe(400);
    const v = await h.req('/api/auth/verify-email?token=x&callbackURL=https%3A%2F%2Fevil.example');
    expect(v.status).toBe(400);
  });
});

describe('rate limiting (per CF-Connecting-IP, stored in Postgres)', () => {
  it('sign-in: 5 attempts per minute, then 429 with Retry-After; other IPs unaffected', async () => {
    const email = await verifiedUser();
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 7; i++) {
      const r = await h.req('/api/auth/sign-in/email', { body: { email, password: 'wrong password 123' }, ip: '198.51.100.20' });
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get('x-retry-after') ?? r.headers.get('retry-after');
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // even the correct password is blocked while limited
    expect((await signIn(email, PASSWORD, new Jar(), '198.51.100.20')).res.status).toBe(429);
    expect((await signIn(email, PASSWORD, new Jar(), '198.51.100.21')).res.status).toBe(200);
    const rows = await h.sql("SELECT count(*)::int AS n FROM rate_limit WHERE key LIKE '%198.51.100.20%'");
    expect(rows.rows[0]!.n).toBeGreaterThan(0);
  });

  it('password-reset requests: 3 per 15 minutes per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await h.req('/api/auth/request-password-reset', { body: { email: uniqueEmail(), redirectTo: '/reset-password' }, ip: '198.51.100.30' })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('database failures', () => {
  const down = () =>
    makeHarness({ dbUrl: 'unused', connect: () => Promise.reject(new DatabaseError('unreachable', 'connect ECONNREFUSED 10.0.0.9:5432 password=s3cret')) });

  it('auth endpoints and protected routes answer 503 without internals when the database is unreachable', async () => {
    const d = down();
    for (const r of [
      await d.req('/api/auth/sign-in/email', { body: { email: uniqueEmail(), password: PASSWORD } }),
      await d.req('/api/auth/sign-up/email', { body: { name: 'X', email: uniqueEmail(), password: PASSWORD } }),
      await d.req('/api/auth/get-session'),
      await d.req('/api/me', { headers: { cookie: 'arc.session_token=x' } }),
    ]) {
      expect(r.status).toBe(503);
      const text = await r.text();
      expect(ApiError.parse(JSON.parse(text)).error.code).toBe('unavailable');
      expect(text).not.toMatch(/s3cret|10\.0\.0\.9|ECONNREFUSED/);
    }
  });

  it('auth config still answers without the database', async () => {
    const r = await down().req('/api/auth-config');
    expect(r.status).toBe(200);
  });
});

/**
 * Remote authentication checks on Cloudflare's edge against the isolated dev Worker → Hyperdrive (ar-creator-db-dev,
 * caching disabled) → Neon development branch as ar_app. Uses a temporary verified user seeded by db:remote.
 * Order matters: at most 5 sign-in requests happen before the CF-Connecting-IP spoofing test (limit 5/min/IP).
 */
import { expect, request as pwRequest, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { ApiError, AuthConfigResponse, HealthResponse, MeResponse, SessionResponse } from '@ar-creator/contracts';

test.describe.configure({ mode: 'serial' });

const BASE = process.env.REMOTE_BASE_URL!;
const EMAIL = process.env.REMOTE_TEST_EMAIL!;
const PASSWORD = process.env.REMOTE_TEST_PASSWORD!;
const json = { 'content-type': 'application/json', origin: BASE };

async function client(): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: BASE });
}
const setCookies = (r: APIResponse) => r.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
const sessionCookie = (r: APIResponse) => setCookies(r).find((c) => c.startsWith('__Secure-arc.session_token='));
async function signIn(ctx: APIRequestContext, password = PASSWORD, headers: Record<string, string> = {}) {
  return ctx.post('/api/auth/sign-in/email', { headers: { ...json, ...headers }, data: { email: EMAIL, password } });
}

test.beforeAll(() => {
  if (!BASE || !EMAIL || !PASSWORD) throw new Error('REMOTE_BASE_URL / REMOTE_TEST_EMAIL / REMOTE_TEST_PASSWORD missing');
});

test('REMOTE-HEALTH: workerd → Hyperdrive → Neon development, migrations current', async () => {
  const ctx = await client();
  const res = await ctx.get('/api/health');
  expect(res.status()).toBe(200);
  const body = HealthResponse.parse(await res.json());
  expect(body).toMatchObject({ status: 'ok', runtime: 'workerd', checks: { database: { status: 'ok', migrations: 'current' } } });
  test.info().annotations.push({ type: 'db-latency-ms', description: String(body.checks.database.latencyMs) });
});

test('REMOTE-STATIC: SPA served over HTTPS with security headers', async () => {
  const ctx = await client();
  const res = await ctx.get('/sign-in');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(res.headers()['content-type']).toContain('text/html');
});

test('REMOTE-SIGNUP-CLOSED: sign-up is advertised closed and refused', async () => {
  const ctx = await client();
  expect(AuthConfigResponse.parse(await (await ctx.get('/api/auth-config')).json()).signupEnabled).toBe(false);
  const r = await ctx.post('/api/auth/sign-up/email', { headers: json, data: { name: 'X', email: 'nobody@ar-creator.invalid', password: 'a long enough password' } });
  expect(r.status()).toBe(403);
});

test('REMOTE-SIGNIN: wrong password 401 (sign-in #1); correct password → __Secure- Secure HttpOnly Lax cookie (sign-in #2)', async () => {
  const ctx = await client();
  const bad = await signIn(ctx, 'definitely not the password');
  expect(bad.status()).toBe(401);
  expect(sessionCookie(bad)).toBeUndefined();

  const t0 = Date.now();
  const ok = await signIn(ctx);
  test.info().annotations.push({ type: 'sign-in-wall-ms', description: String(Date.now() - t0) });
  expect(ok.status()).toBe(200);
  expect(await ok.text()).not.toContain('"token"');
  const cookie = sessionCookie(ok);
  expect(cookie, 'expected __Secure-arc.session_token').toBeDefined();
  expect(cookie).toMatch(/;\s*Secure/i);
  expect(cookie).toMatch(/;\s*HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Lax/i);

  const me = await ctx.get('/api/me');
  expect(me.status()).toBe(200);
  expect(MeResponse.parse(await me.json()).user).toMatchObject({ email: EMAIL, emailVerified: true });
  expect(SessionResponse.parse(await (await ctx.get('/api/session')).json()).user?.email).toBe(EMAIL);

  // Sign-out revokes server-side immediately through Hyperdrive (caching disabled): replay → 401.
  const raw = cookie!.split(';')[0]!;
  expect((await ctx.post('/api/auth/sign-out', { headers: json, data: {} })).status()).toBe(200);
  const replay = await (await client()).get('/api/me', { headers: { cookie: raw } });
  expect(replay.status()).toBe(401);
});

test('REMOTE-REVOKE-ALL: revoke-sessions signs out every device (sign-ins #3, #4)', async () => {
  const a = await client();
  const b = await client();
  expect((await signIn(a)).status()).toBe(200);
  expect((await signIn(b)).status()).toBe(200);
  expect((await b.get('/api/me')).status()).toBe(200);
  expect((await a.post('/api/auth/revoke-sessions', { headers: json, data: {} })).status()).toBe(200);
  expect((await b.get('/api/me')).status()).toBe(401);
  expect((await a.get('/api/me')).status()).toBe(401);
});

test('REMOTE-BROWSER: real browser sign-in over HTTPS reaches /account; cookie invisible to scripts (sign-in #5)', async ({ page, context }) => {
  await page.goto('/account');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount$/);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId('account-email')).toHaveText(EMAIL);
  const c = (await context.cookies()).find((x) => x.name === '__Secure-arc.session_token');
  expect(c).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('session_token');
  await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
  await expect(page).toHaveURL(/\/sign-in\?signedOut=1$/);
});

test('REMOTE-GUARDS: CSRF, endpoint allowlist, redirect guards, unauthenticated access', async () => {
  const ctx = await client();
  const csrf = await ctx.post('/api/auth/sign-in/email', { headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, data: { email: EMAIL, password: PASSWORD } });
  expect(csrf.status()).toBe(403);
  expect((await ctx.get('/api/auth/list-sessions')).status()).toBe(404);
  const redirect = await ctx.post('/api/auth/request-password-reset', { headers: json, data: { email: EMAIL, redirectTo: 'https://evil.example/steal' } });
  expect(redirect.status()).toBe(400);
  const me = await ctx.get('/api/me');
  expect(me.status()).toBe(401);
  expect(ApiError.parse(await me.json()).error.code).toBe('unauthorized');
});

test('REMOTE-CF-IP: a client-supplied CF-Connecting-IP never reaches the Worker (blocked at the edge)', async () => {
  // Observed 2026-11-15: Cloudflare answers requests that carry their own CF-Connecting-IP with
  // 403 "error code: 1000" (text/plain, Server: cloudflare) before the Worker runs. So the rate-limit key
  // (CF-Connecting-IP) cannot be spoofed by clients. Anything that DID reach the Worker would be JSON.
  const ctx = await client();
  for (let i = 0; i < 3; i++) {
    const r = await signIn(ctx, 'definitely not the password', { 'cf-connecting-ip': `203.0.113.${10 + i}` });
    const type = r.headers()['content-type'] ?? '';
    test.info().annotations.push({ type: `spoof-${i}`, description: `${r.status()} ${type}` });
    expect([403, 429]).toContain(r.status());
    expect(type).not.toContain('application/json'); // never answered by the Worker
    expect(setCookies(r)).toEqual([]);
  }
});

test('REMOTE-RATE-LIMIT: wrong passwords from the real client IP are limited at the edge (5/min)', async () => {
  // Sign-ins #1–#5 above already used this IP's budget; further attempts must be 429 within a few tries.
  const ctx = await client();
  const statuses: number[] = [];
  for (let i = 0; i < 7 && !statuses.includes(429); i++) statuses.push((await signIn(ctx, 'definitely not the password')).status());
  test.info().annotations.push({ type: 'statuses', description: statuses.join(',') });
  expect(statuses).toContain(429);
  const limited = await signIn(ctx); // even the CORRECT password is refused while limited
  expect(limited.status()).toBe(429);
  expect(Number(limited.headers()['x-retry-after'] ?? limited.headers()['retry-after'] ?? '0')).toBeGreaterThan(0);
});

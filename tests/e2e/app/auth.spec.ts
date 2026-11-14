/**
 * Milestone 3 browser flows in workerd (vite dev and the production build via vite preview), local Postgres,
 * dev mailbox for emails (APP_ENV=development from apps/web/.dev.vars). Requires `npm run db:up && npm run db:migrate`.
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery staple';

// Each test is its own "client IP" so per-IP rate limits (5 sign-ups/hour) do not couple tests. Locally workerd
// trusts this header; on Cloudflare's edge CF-Connecting-IP is set by Cloudflare (see TESTING.md).
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'cf-connecting-ip': `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` });
});

const uniqueEmail = () => `e2e-${randomBytes(5).toString('hex')}@example.com`;

async function mailLink(request: APIRequestContext, to: string, kind: 'verify-email' | 'reset-password'): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await request.get(`/api/dev/mailbox?to=${encodeURIComponent(to)}`);
    expect(res.status()).toBe(200);
    const { messages } = (await res.json()) as { messages: { kind: string; text: string }[] };
    const m = messages.filter((x) => x.kind === kind).at(-1);
    const link = m && /https?:\/\/\S+/.exec(m.text)?.[0];
    if (link) return new URL(link).pathname + new URL(link).search;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no ${kind} email for ${to}`);
}

async function signUpAndVerify(page: Page, request: APIRequestContext, email = uniqueEmail()) {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Creator');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await page.goto(await mailLink(request, email, 'verify-email'));
  await expect(page).toHaveURL(/\/email-verified$/);
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  return email;
}

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('sign-up → email verification → sign-in → session persists → sign-out revokes the session', async ({ page, request, context }) => {
  const email = await signUpAndVerify(page, request);
  await page.getByRole('link', { name: 'Continue to sign in' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your email is confirmed' })).toBeVisible();
  await signIn(page, email);
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId('account-email')).toHaveText(email);

  // Cookie flags as seen by the browser (http locally → no Secure; https in production adds Secure + __Secure-).
  const cookie = (await context.cookies()).find((c) => c.name === 'arc.session_token');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('session_token'); // invisible to scripts

  await page.reload();
  await expect(page.getByTestId('account-email')).toHaveText(email); // persists across reloads

  const stolen = `arc.session_token=${cookie!.value}`;
  await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
  await expect(page).toHaveURL(/\/sign-in\?signedOut=1$/);
  await expect(page.getByRole('status').filter({ hasText: 'You have been signed out.' })).toBeVisible();
  // Server-side revocation: replaying the old cookie no longer authenticates.
  const replay = await request.get('/api/me', { headers: { cookie: stolen } });
  expect(replay.status()).toBe(401);
  await page.goto('/account');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount$/);
});

test('protected route redirects to sign-in and returns to the requested page afterwards', async ({ page, request }) => {
  const email = await signUpAndVerify(page, request);
  await page.goto('/account');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount$/);
  await signIn(page, email);
  await expect(page).toHaveURL(/\/account$/);
});

test('sign-in shows validation errors, wrong-password errors and the unverified-email state', async ({ page, request }) => {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  await expect(page.getByLabel('Email')).toBeFocused();
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');

  const email = await signUpAndVerify(page, request);
  await page.goto('/sign-in');
  await signIn(page, email, 'not the right password');
  await expect(page.getByRole('alert')).toHaveText('That email and password combination is not correct.');
  await expect(page.getByLabel('Password')).toHaveValue('');

  // Unverified account
  const unverified = uniqueEmail();
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Pending');
  await page.getByLabel('Email').fill(unverified);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await page.goto('/sign-in');
  await signIn(page, unverified);
  await expect(page.getByRole('alert')).toContainText('Confirm your email address first');
});

test('sign-up validates the password policy on the client', async ({ page }) => {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('X');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Use at least 12 characters.')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeFocused();
});

test('forgot password → email link → new password → old password rejected, new one works', async ({ page, request }) => {
  const email = await signUpAndVerify(page, request);
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If an account exists for that address');

  await page.goto(await mailLink(request, email, 'reset-password'));
  await expect(page).toHaveURL(/\/reset-password\?token=/);
  const newPassword = 'a brand new passphrase';
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill('mismatch mismatch');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByText('Passwords do not match.')).toBeVisible();
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page).toHaveURL(/\/sign-in\?reset=1$/);

  await signIn(page, email, PASSWORD);
  await expect(page.getByRole('alert')).toHaveText('That email and password combination is not correct.');
  await signIn(page, email, newPassword);
  await expect(page).toHaveURL(/\/account$/);
});

test('an invalid reset link shows a helpful error instead of the form', async ({ page }) => {
  await page.goto('/reset-password?error=INVALID_TOKEN');
  await expect(page.getByRole('heading', { name: 'This link did not work' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
});

test('unauthorized API requests are refused', async ({ request }) => {
  expect((await request.get('/api/me')).status()).toBe(401);
  expect((await request.get('/api/me', { headers: { cookie: 'arc.session_token=forged.token' } })).status()).toBe(401);
  // Cross-site POSTs are refused even without cookies (login CSRF protection).
  const csrf = await request.post('/api/auth/sign-in/email', {
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    data: { email: 'x@example.com', password: PASSWORD },
  });
  expect(csrf.status()).toBe(403);
  expect((await request.get('/api/auth/list-sessions')).status()).toBe(404);
});

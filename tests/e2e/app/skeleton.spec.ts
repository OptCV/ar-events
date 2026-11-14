import { expect, test, type Page } from '@playwright/test';
import { ApiError, HealthResponse } from '@ar-creator/contracts';

function watchProblems(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  });
  return problems;
}

test('home renders and reports the API as operational from workerd', async ({ page }, info) => {
  const problems = watchProblems(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Create and publish AR experiences' })).toBeVisible();
  const status = page.getByTestId('system-status');
  await expect(status.getByRole('status')).toHaveText('Operational');
  await expect(status).toContainText('workerd');
  const build = (await status.locator('code').textContent()) ?? '';
  if (info.project.name === 'app-preview') expect(build).toMatch(/^[0-9a-f]{12}(-dirty)?$/);
  else expect(build).toBe('dev');
  expect(problems).toEqual([]); // includes CSP violations in preview
});

test('GET /api/health is contract-valid, uncached and served by workerd', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const body = HealthResponse.parse(await res.json());
  expect(body.runtime).toBe('workerd');
  expect(res.headers()['cache-control']).toBe('no-store');
  expect(res.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
});

test('unknown /api routes hit the Worker (JSON 404), not the SPA fallback', async ({ request }) => {
  const res = await request.get('/api/definitely-not-a-route');
  expect(res.status()).toBe(404);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(ApiError.parse(await res.json()).error.code).toBe('not_found');
});

test('client-side deep links fall back to the SPA', async ({ page }) => {
  const res = await page.goto('/some/deep/client/route');
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-type']).toContain('text/html');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to the home page' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('keyboard: first Tab reaches the skip link, which moves focus to main', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});

test('static responses carry security headers and immutable asset caching @prod-only', async ({ page, request }) => {
  const res = await request.get('/');
  const h = res.headers();
  expect(h['content-security-policy']).toContain("script-src 'self'");
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  await page.goto('/');
  const script = await page.locator('script[type="module"]').first().getAttribute('src');
  expect(script).toMatch(/^\/assets\/.+\.js$/);
  const asset = await request.get(script!);
  expect(asset.headers()['cache-control']).toContain('immutable');
  // No public client source maps. Unknown paths get the SPA fallback (index.html), so check the payload, not the status.
  const map = await request.get(`${script}.map`);
  expect(map.headers()['content-type']).toContain('text/html');
  expect(await map.text()).not.toContain('"sourcesContent"');
});

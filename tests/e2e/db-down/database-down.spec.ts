import { expect, test } from '@playwright/test';
import { HealthResponse } from '@ar-creator/contracts';

// Served by a `vite dev` whose Hyperdrive local connection string points at a closed port with a fake password
// (see playwright.config.ts, project `app-db-down`).
const FAKE_PASSWORD = 'e2e-fake-password-never-real';

test('database unreachable → 503 degraded with a safe category, no connection details', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(503);
  const text = await res.text();
  const body = HealthResponse.parse(JSON.parse(text));
  expect(body.status).toBe('degraded');
  expect(body.checks.database.status).toBe('error');
  expect(['unreachable', 'timeout']).toContain(body.checks.database.error);
  for (const leak of [FAKE_PASSWORD, '127.0.0.1', 'postgres://', 'ECONNREFUSED', ':1/']) expect(text).not.toContain(leak);
});

test('home page shows a degraded state instead of failing', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('system-status').getByRole('status')).toHaveText('Degraded');
  await expect(page.getByTestId('database-status')).toHaveText('Database: Unavailable');
});

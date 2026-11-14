import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { HealthResponse } from '@ar-creator/contracts';

/**
 * Requires local Docker Postgres (`npm run db:up` + `npm run db:migrate`). Never skipped silently.
 * Checks for ACTUAL secrets: the local DB password and any credentialed connection URL (scheme://user:pass@).
 * Env var *names* and the pg driver's internal "postgres://base" literal are not secrets.
 */
function localPassword(): string {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
  const pw = process.env.POSTGRES_PASSWORD;
  if (!pw) throw new Error('POSTGRES_PASSWORD missing from .env — run `npm run db:up`.');
  return pw;
}
const CREDENTIALED_URL = /\b(?:postgres(?:ql)?|mysql):\/\/[^\s"'`/@:]+:[^\s"'`/@]+@/;
function assertNoSecrets(text: string, where: string, pw: string) {
  expect(text.includes(pw), `database password found in ${where}`).toBe(false);
  expect(CREDENTIALED_URL.test(text), `credentialed connection URL found in ${where}`).toBe(false);
  expect(text.includes('localConnectionString'), `localConnectionString found in ${where}`).toBe(false);
}

test('health reports the database through the Hyperdrive binding (workerd → local Postgres)', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const body = HealthResponse.parse(await res.json());
  expect(body.runtime).toBe('workerd');
  expect(body.checks.database).toMatchObject({ status: 'ok', migrations: 'current' });
});

test('home page shows the database as connected', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('database-status')).toHaveText('Database: Connected');
});

test('no database credentials reach the browser', async ({ page, request }) => {
  const pw = localPassword();
  await page.goto('/');
  const sources = await page
    .locator('script[src], link[rel="stylesheet"][href]')
    .evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).src || (e as HTMLLinkElement).href));
  expect(sources.length).toBeGreaterThan(0);
  const bodies = [
    await page.content(),
    ...(await Promise.all(sources.map(async (u) => (await request.get(u)).text()))),
    await (await request.get('/api/health')).text(),
  ];
  bodies.forEach((body, i) => assertNoSecrets(body, `browser-visible response #${i}`, pw));
});

test('production build output contains no database credentials @prod-only', async () => {
  const pw = localPassword();
  const dist = fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dist);
  expect(files.length).toBeGreaterThan(3);
  for (const f of files) assertNoSecrets(readFileSync(f, 'utf8'), f, pw);
  // The deployable config carries only the Hyperdrive ID.
  const cfg = JSON.parse(readFileSync(join(dist, 'ar_creator', 'wrangler.json'), 'utf8'));
  expect(cfg.hyperdrive).toEqual([{ binding: 'HYPERDRIVE', id: '8de2df3d333b4a1b9b07c18fbdd49d18' }]);
});

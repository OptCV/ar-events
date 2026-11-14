import { expect, test, type ConsoleMessage } from '@playwright/test';

function collectProblems(page: import('@playwright/test').Page) {
  const problems: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  });
  return problems;
}

test('device lab lists every P0 case with correct runtime links', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto('/');
  await expect(page.locator('section')).toHaveCount(7);
  // Android image case → WebXR probe, never a Scene Viewer intent.
  const img = page.locator('#img-overlay');
  await expect(img.getByRole('link', { name: 'Open WebXR image probe' })).toHaveAttribute('href', 'webxr/');
  await expect(img.locator('a[href^="intent://"]')).toHaveCount(0);
  // Wall → Scene Viewer with vertical placement.
  await expect(page.locator('#wall-probe a[href^="intent://"]')).toHaveAttribute('href', /enable_vertical_placement=true/);
  await expect(page.locator('#floor-probe a[href^="intent://"]')).not.toHaveAttribute('href', /enable_vertical_placement/);
  // iOS → rel=ar with an <img> child.
  await expect(page.locator('a[rel="ar"] > img')).toHaveCount(7);
  expect(problems).toEqual([]);
});

test('webxr probe: desktop takes the honest unsupported path without errors', async ({ page }) => {
  const problems = collectProblems(page);
  const res = await page.goto('/webxr/');
  expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
  const checks = page.locator('#preflight li');
  await expect(checks.filter({ hasText: 'Tracking target + probe GLB loaded' })).toHaveClass('ok', { timeout: 15_000 });
  await expect(checks.filter({ hasText: 'immersive-ar session supported' })).toHaveClass('bad');
  await expect(page.getByRole('button', { name: 'Start AR' })).toBeDisabled();
  await expect(page.locator('#result')).toContainText('unsupported-device path');
  const report = JSON.parse((await page.locator('#report').textContent()) ?? '{}');
  expect(report.outcome).toBe('preflight-failed');
  expect(report.assets.glbSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(report.error).toBeUndefined();
  expect(report.probe).toBe('p0-webxr-probe@0.2.0');
  expect(['ua-client-hints', 'user-agent-only']).toContain(report.device?.source);
  // Tester observations flow into the report; clearing removes them.
  await page.getByLabel('Card exactly covers the printed target').selectOption('partly');
  await page.getByLabel('Printed target width measured with a ruler (cm)').fill('19.8');
  await page.getByLabel('Printed target width measured with a ruler (cm)').blur();
  const withObs = JSON.parse((await page.locator('#report').textContent()) ?? '{}');
  expect(withObs.observations).toEqual({ cardCoversPrint: 'partly', printedWidthCm: '19.8' });
  await page.getByLabel('Card exactly covers the printed target').selectOption('');
  expect(JSON.parse((await page.locator('#report').textContent()) ?? '{}').observations).toEqual({ printedWidthCm: '19.8' });
  expect(problems).toEqual([]); // includes CSP violations (blob: textures, module scripts)
});


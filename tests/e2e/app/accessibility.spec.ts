/**
 * Accessibility audit (Phase 6 M20, ADR-038): axe-core WCAG 2.0–2.2 A/AA rules on every page kind, signed out, signed
 * in, and as a visitor of a published experience. Automated rules catch roughly a third of WCAG problems; manual
 * screen-reader passes on devices are still pending (TESTING.md).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createExperience, verifiedSignedIn } from './helpers.ts';

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const summary = r.violations.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(r.passes.length, `${where}: axe ran its rules`).toBeGreaterThan(10);
  expect(summary, `${where}: axe violations`).toEqual([]);
}

test('signed-out pages have no WCAG 2.2 A/AA violations', async ({ page }) => {
  for (const [path, ready] of [
    ['/', 'main'],
    ['/sign-in', 'form'],
    ['/sign-up', 'main'],
    ['/forgot-password', 'form'],
    ['/no-such-page', 'main'],
    ['/x/no-such-experience', 'h1'],
  ] as const) {
    await page.goto(path);
    await page.locator(ready).first().waitFor();
    await page.waitForLoadState('networkidle');
    await audit(page, path);
  }
});

test('signed-in pages, the editor with content, and the published page have no WCAG 2.2 A/AA violations; keyboard reaches Publish', async ({ page, request, browser }) => {
  test.setTimeout(180_000);
  await verifiedSignedIn(page, request, 'a11y');
  await page.goto('/dashboard');
  await page.getByRole('heading', { level: 1 }).waitFor();
  await audit(page, '/dashboard');
  await page.goto('/library');
  await page.getByRole('heading', { level: 1 }).waitFor();
  await audit(page, '/library');
  await page.goto('/account');
  await page.getByRole('heading', { level: 1 }).waitFor();
  await audit(page, '/account');

  await createExperience(page, 'Accessible shop', 'Floor');
  await page.getByTestId('add-content').getByRole('button', { name: 'Add shape' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await page.waitForLoadState('networkidle');
  await audit(page, 'editor');

  // Keyboard only: Publish is reachable with Tab and works with Enter.
  const publish = page.getByTestId('publish').getByRole('button', { name: 'Publish', exact: true });
  await publish.focus();
  await expect(publish).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('publish')).toHaveAttribute('data-state', 'published', { timeout: 90_000 });
  await audit(page, 'editor (published)');

  const url = (await page.getByTestId('publish').getByTestId('public-link').getAttribute('href'))!;
  const visitor = await browser.newContext();
  const v = await visitor.newPage();
  await v.goto(url);
  await v.getByTestId('public-page').waitFor();
  await v.waitForLoadState('networkidle');
  await audit(v, 'public page');
  await visitor.close();
});

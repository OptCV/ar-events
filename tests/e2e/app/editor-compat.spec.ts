/**
 * Phase 4 Milestone 13: the interaction plan in the editor — compatibility matrix per viewer, warnings (also in the
 * server's publish check), and the experience page's buttons. The Phase 4 gate itself is proven exhaustively in
 * packages/capabilities/src/interactions.test.ts; this checks that the editor shows it.
 */
import { expect, test, type Page } from '@playwright/test';
import { createExperience, verifiedSignedIn } from './helpers.ts';

async function addAction(page: Page, type: string, fields: Record<string, string>) {
  const panel = page.getByTestId('actions-panel');
  await panel.getByRole('button', { name: 'Add action' }).click();
  const form = panel.getByRole('form', { name: 'New action' });
  await form.getByLabel('What it does').selectOption({ label: type });
  for (const [label, value] of Object.entries(fields)) {
    const field = form.getByLabel(label, { exact: true });
    if ((await field.evaluate((el) => el.tagName)) === 'SELECT') await field.selectOption({ label: value });
    else await field.fill(value);
  }
  await form.getByRole('button', { name: 'Add' }).click();
}

test('compatibility: per-viewer routes for the main button, links and behaviours; warnings; page buttons; follows the placement', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p4compat');
  await createExperience(page, 'Compat scene', 'Floor');
  const compat = page.getByTestId('compatibility');
  await expect(compat).toContainText('Add objects or actions to see how each viewer will show them.');

  await page.getByTestId('add-content').getByRole('button', { name: 'Add shape' }).click();
  await addAction(page, 'Open a web page', { 'Web address': 'https://example.com/shop', 'Button text (optional)': 'Shop now' });
  await addAction(page, 'Send an email', { 'Email address': 'hello@example.com' });
  await addAction(page, 'Show or hide an object', { Object: 'Box' });
  await page.getByTestId('actions-panel').getByLabel('Main button').selectOption({ index: 1 });
  await page.getByTestId('tree-row').getByRole('button', { name: /^Box/ }).click();
  await page.getByTestId('inspector').getByLabel('On tap').selectOption({ label: 'Show or hide “Box”' });
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');

  // Columns are the two viewers of floor placement.
  await expect(compat.locator('thead th')).toHaveText(['In this scene', 'iPhone and iPad (Quick Look)', 'Android (Scene Viewer)']);
  await expect(compat.getByTestId('compat-feature-shape')).toContainText('Planned, not yet device-tested');
  await expect(compat.getByTestId('compat-feature-primary_cta')).toBeVisible();
  await expect(compat.getByTestId('compat-feature-additional_links')).toBeVisible();
  const rows = compat.getByTestId('compat-action');
  await expect(rows.nth(0).locator('td').nth(0)).toContainText('Main button (Quick Look banner)');
  await expect(rows.nth(0).locator('td').nth(0)).toContainText('Experience page');
  await expect(rows.nth(0).locator('td').nth(1)).toContainText('Main button (Scene Viewer link)');
  await expect(rows.nth(1).locator('td').nth(0)).toHaveText('Experience page');
  await expect(rows.nth(2).locator('td').nth(0)).toHaveText('Not availableQuick Look cannot show or hide objects on request.');
  await expect(rows.nth(2).locator('td').nth(1)).toContainText('Scene Viewer cannot show or hide objects on request.');

  // Warnings: in the editor and in the server's publish check (non-blocking).
  const issues = compat.getByTestId('compat-issues');
  await expect(issues).toContainText('Show or hide “Box” does not work in iPhone and iPad (Quick Look) and Android (Scene Viewer)');
  await expect(issues).toContainText('Tapping “Box” does nothing in iPhone and iPad (Quick Look) and Android (Scene Viewer); the action is not available there.');
  await expect(page.getByTestId('readiness')).toHaveText('Ready to publish (publishing arrives in a later milestone).');
  await expect(page.getByRole('complementary')).toContainText('Tapping “Box” does nothing');

  // The experience page keeps every link, main button first; behaviours are not page buttons.
  await expect(page.getByTestId('page-preview').getByTestId('page-button')).toHaveText(['Shop now', 'Send email']);

  // Image placement: Android becomes WebXR image tracking, where taps and on-screen buttons are experimental.
  await page.getByText('Image anchored', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch placement' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await expect(compat.locator('thead th')).toHaveText(['In this scene', 'iPhone and iPad (Quick Look)', 'Android (image tracking, experimental)']);
  await expect(compat.getByTestId('compat-feature-image_target_recognition')).toBeVisible();
  await expect(rows.nth(0).locator('td').nth(1)).toContainText('On-screen button · experimental');
  await expect(rows.nth(2).locator('td').nth(1)).toHaveText('Tap · experimental');
  await expect(issues).toContainText('Tapping “Box” does nothing in iPhone and iPad (Quick Look); the action is not available there.');
  await expect(issues).not.toContainText('Android (Scene Viewer)');
});

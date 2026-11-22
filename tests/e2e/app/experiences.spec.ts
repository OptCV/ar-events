/**
 * Milestone 4 browser flows in workerd (dev and production build) against local Postgres.
 * Requires `npm run db:up && npm run db:migrate`.
 */
import { expect, test, type Browser } from '@playwright/test';
import { createExperience, verifiedSignedIn } from './helpers.ts';

test('dashboard: empty state → create → listed with placement → rename → search → delete', async ({ page, request }) => {
  await verifiedSignedIn(page, request);
  await expect(page.getByRole('heading', { name: 'Create your first AR experience' })).toBeVisible();

  await createExperience(page, 'Gallery wall', 'Wall');
  await expect(page.getByRole('radio', { name: /Wall/ })).toBeChecked();
  await expect(page.getByTestId('readiness')).toHaveText(/Not ready yet/);
  await expect(page.getByText('Add at least one object to the scene.')).toBeVisible();

  // Rename via Details
  await page.getByRole('textbox', { name: 'Name' }).fill('Gallery wall (renamed)');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Details saved.' })).toBeVisible();

  await page.getByRole('link', { name: '← Your experiences' }).click();
  const card = page.getByRole('link', { name: /Gallery wall \(renamed\)/ });
  await expect(card).toContainText('Wall');
  await expect(card).toContainText('Draft');

  await createExperience(page, 'Lobby sculpture', 'Floor');
  await page.goto('/dashboard');
  await expect(page.getByRole('list', { name: 'Experiences' }).getByRole('listitem')).toHaveCount(2);
  await page.getByLabel('Search experiences').fill('lobby');
  await expect(page.getByRole('list', { name: 'Experiences' }).getByRole('listitem')).toHaveCount(1);

  // Delete
  await page.getByRole('link', { name: /Lobby sculpture/ }).click();
  await page.getByRole('button', { name: 'Delete experience' }).click();
  const dialog = page.getByRole('dialog', { name: /Delete “Lobby sculpture”/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('list', { name: 'Experiences' }).getByRole('listitem')).toHaveCount(1);
});

test('placement change needs explicit review; image width autosaves and persists', async ({ page, request }) => {
  await verifiedSignedIn(page, request);
  const url = await createExperience(page, 'Poster', 'Floor');

  // Cancel keeps the current placement
  await page.getByText('Image anchored', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Switch to image placement/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('placement-warnings')).toContainText('needs a tracking image');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('radio', { name: /Floor/ })).toBeChecked();

  // Escape also cancels
  await page.getByText('Wall', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: /Switch to wall placement/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('radio', { name: /Floor/ })).toBeChecked();

  // Confirm switches and saves
  await page.getByText('Image anchored', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch placement' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await expect(page.getByRole('radio', { name: /Image anchored/ })).toBeChecked();
  await expect(page.getByText('Choose a tracking image for image placement.')).toBeVisible();

  // Width validation and autosave
  const width = page.getByLabel('Printed width of the tracking image (cm)');
  await expect(width).toHaveValue('20');
  await width.fill('1');
  await expect(page.getByText('Enter a width between 3 and 500 cm.')).toBeVisible();
  await width.fill('25.5');
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await page.reload();
  await expect(page.getByLabel('Printed width of the tracking image (cm)')).toHaveValue('25.5');
  expect(page.url()).toBe(url);

  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: /Poster/ })).toContainText('Image anchored');
});

test('two tabs editing the same draft: the stale one gets a conflict and can load the latest', async ({ page, request, context }) => {
  await verifiedSignedIn(page, request);
  const url = await createExperience(page, 'Shared poster', 'Image anchored');
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByLabel('Printed width of the tracking image (cm)')).toHaveValue('20');

  await page.getByLabel('Printed width of the tracking image (cm)').fill('30');
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');

  await other.getByLabel('Printed width of the tracking image (cm)').fill('40');
  await expect(other.getByTestId('save-status')).toHaveText('Not saved');
  await expect(other.getByRole('alert')).toContainText('changed in another tab');
  await other.getByRole('button', { name: 'Load the latest version' }).click();
  await expect(other.getByLabel('Printed width of the tracking image (cm)')).toHaveValue('30');
});

test("another user's experience URL shows 'not found' and the API returns 404", async ({ page, request, browser }) => {
  await verifiedSignedIn(page, request);
  const url = await createExperience(page, 'Private draft', 'Floor');
  const id = url.split('/').pop()!;

  const ctx = await (browser as Browser).newContext({ baseURL: new URL(url).origin });
  const intruder = await ctx.newPage();
  await verifiedSignedIn(intruder, ctx.request);
  await intruder.goto(`/experiences/${id}`);
  await expect(intruder.getByRole('heading', { name: 'Experience not found' })).toBeVisible();
  expect((await ctx.request.get(`/api/experiences/${id}`)).status()).toBe(404);
  await ctx.close();
});

test('dashboard and editor are protected', async ({ page }) => {
  for (const path of ['/dashboard', '/experiences/new', '/experiences/00000000-0000-4000-8000-000000000000']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in\?next=/);
  }
});

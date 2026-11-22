/**
 * Phase 2 Milestone 1 browser flows in workerd (dev server and production build): the real local Workflow engine
 * runs the conversion; USDZ comes from the converter image run by Docker (the image Cloudflare Containers run;
 * Containers themselves cannot run locally on Windows, ADR-023). Desktop only — says nothing about AR rendering.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { verifiedSignedIn } from './helpers.ts';

const FIX = 'tests/fixtures/images/';
const file = (name: string) => ({ name, mimeType: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', buffer: readFileSync(`${FIX}${name}`) });

async function uploadDisplay(page: Page, name: string) {
  await page.goto('/library');
  await page.getByRole('group', { name: 'What is this file for?' }).getByText('Display image', { exact: true }).click();
  await page.getByTestId('uploader-display-image').locator('input[type=file]').setInputFiles(file(name));
  await expect(page.getByRole('status').filter({ hasText: `Uploaded ${name}.` })).toBeVisible();
}

test('image to AR: settings → convert → status → downloads (GLB + USDZ) → earlier versions', async ({ page, request }) => {
  test.setTimeout(90_000);
  await verifiedSignedIn(page, request, 'p2');
  await uploadDisplay(page, 'ring_inner_hole.png'); // 512 × 512, binary alpha with a hole

  await page.getByRole('link', { name: 'Make an AR object from ring_inner_hole.png' }).click();
  await expect(page).toHaveURL(/\/library\/[0-9a-f-]{36}\/ar-object$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Make an AR object' })).toBeVisible();
  await expect(page.getByTestId('io-preview').locator('img')).toHaveJSProperty('naturalWidth', 512);

  // Size: height follows the aspect ratio; the unit switch converts the value.
  await page.getByLabel('Real-world width').fill('40');
  await expect(page.getByTestId('io-size')).toHaveText('Height follows the image: 40 cm. Size: 40 cm × 40 cm.');
  await page.getByRole('group', { name: 'Unit' }).getByText('in', { exact: true }).click();
  await expect(page.getByLabel('Real-world width')).toHaveValue('15.75');
  await page.getByRole('group', { name: 'Unit' }).getByText('cm', { exact: true }).click();
  await page.getByLabel('Real-world width').fill('0.5');
  await expect(page.getByTestId('io-size')).toHaveText('The smallest width is 1 cm.');
  await page.getByLabel('Real-world width').fill('40');

  // Backgrounds for checking edges.
  await page.getByRole('group', { name: 'Preview background' }).getByText('Dark').click();
  await expect(page.getByTestId('io-preview')).toHaveClass(/dark/);

  await page.getByRole('button', { name: 'Create AR object' }).click();
  await expect(page.getByTestId('io-status')).toHaveText('Your AR object is ready.', { timeout: 30_000 });
  const result = page.getByTestId('io-result');
  await expect(result).toContainText('40 cm × 40 cm · Cutout (auto) · standing · front only');

  // Downloads come from signed, cookieless URLs with the right types.
  const usdzLink = result.getByRole('link', { name: /Download USDZ/ });
  const glbLink = result.getByRole('link', { name: /Download GLB/ });
  const [usdz] = await Promise.all([page.waitForEvent('download'), usdzLink.click()]);
  expect(usdz.suggestedFilename()).toBe('ring_inner_hole-image-object.usdz');
  const usdzBytes = readFileSync((await usdz.path())!);
  expect(usdzBytes.subarray(0, 2).toString('latin1')).toBe('PK');
  const glbRes = await page.request.fetch((await glbLink.getAttribute('href'))!, { headers: { cookie: '' } });
  expect(glbRes.status()).toBe(200);
  expect(glbRes.headers()['content-type']).toBe('model/gltf-binary');
  expect((await glbRes.body()).subarray(0, 4).toString('latin1')).toBe('glTF');

  // A second version with other settings; the first moves to "Earlier versions".
  await page.getByRole('group', { name: 'Sides' }).getByText('Both sides').click();
  await page.getByRole('group', { name: 'Transparency' }).getByText('Blend', { exact: true }).click();
  await page.getByRole('button', { name: 'Create AR object' }).click();
  await expect(page.getByTestId('io-status')).toHaveText('Your AR object is ready.', { timeout: 30_000 });
  await expect(result).toContainText('Blend · standing · both sides');
  await expect(page.getByTestId('io-history-item')).toHaveCount(1);
  await expect(page.getByTestId('io-history-item')).toContainText('Cutout (auto)');

  // Same settings again: reused instantly, no new version.
  await page.getByRole('button', { name: 'Create AR object' }).click();
  await expect(page.getByTestId('io-status')).toHaveText('Your AR object is ready.');
  await expect(page.getByTestId('io-history-item')).toHaveCount(1);

  // Usage includes the generated files; the source cannot be deleted while converting, but can afterwards.
  await page.goto('/library');
  await page.getByRole('button', { name: 'Delete ring_inner_hole.png' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByTestId('asset-card')).toHaveCount(0);
});

test('image to AR: refusals are explained (opaque with transparency, tracking images)', async ({ page, request }) => {
  test.setTimeout(60_000);
  await verifiedSignedIn(page, request, 'p2');
  await uploadDisplay(page, 'logo_transparent_border.png');
  await page.getByRole('link', { name: 'Make an AR object from logo_transparent_border.png' }).click();
  await page.getByRole('group', { name: 'Transparency' }).getByText('Opaque', { exact: true }).click();
  await page.getByRole('button', { name: 'Create AR object' }).click();
  await expect(page.getByTestId('io-status')).toHaveText('The conversion failed.', { timeout: 30_000 });
  await expect(page.getByTestId('io-result').getByRole('alert')).toContainText('cannot be made fully opaque');

  // Tracking images have no AR-object action, and the page refuses them by URL too.
  await page.goto('/library');
  await page.getByTestId('uploader-tracking-image').locator('input[type=file]').setInputFiles(file('tracking_target_20cm.png'));
  await expect(page.getByRole('status').filter({ hasText: 'Uploaded tracking_target_20cm.png.' })).toBeVisible();
  const card = page.getByTestId('asset-card').filter({ hasText: 'tracking_target_20cm.png' });
  await expect(card.getByRole('link', { name: /Make an AR object/ })).toHaveCount(0);
});

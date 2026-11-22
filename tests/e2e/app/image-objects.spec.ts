/**
 * Phase 2 Milestone 1 browser flows in workerd (dev server and production build): the real local Workflow engine
 * runs the conversion; USDZ comes from the converter image run by Docker (the image Cloudflare Containers run;
 * Containers themselves cannot run locally on Windows, ADR-023). Desktop only — says nothing about AR rendering.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createExperience, verifiedSignedIn } from './helpers.ts';

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

test('image to AR (M7): soft-edge highlight, 3D preview of the result, place it in an experience', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p2m7');

  // Hard cutout: no partly transparent pixels.
  await uploadDisplay(page, 'ring_inner_hole.png');
  await page.getByRole('link', { name: 'Make an AR object from ring_inner_hole.png' }).click();
  await page.getByLabel('Highlight partly transparent pixels').check();
  await expect(page.getByTestId('soft-edges')).toHaveText('No partly transparent pixels');

  // Antialiased disc: soft edges are found and marked.
  await uploadDisplay(page, 'aa_disc_dark_fringe.png');
  await page.getByRole('link', { name: 'Make an AR object from aa_disc_dark_fringe.png' }).click();
  await page.getByLabel('Highlight partly transparent pixels').check();
  await expect(page.getByTestId('soft-edges')).toHaveText(/^Partly transparent: \d+(\.\d)?% \(magenta\)$/);

  await page.getByLabel('Real-world width').fill('30');
  await page.getByRole('button', { name: 'Create AR object' }).click();
  await expect(page.getByTestId('io-status')).toHaveText('Your AR object is ready.', { timeout: 30_000 });
  const preview = page.getByTestId('model-preview');
  await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(preview.getByRole('img', { name: /3D preview of the AR object: 30 cm × 30 cm · Blend/ })).toBeVisible();
  // Dragging orbits the camera (render on demand) without errors.
  const box = (await preview.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await expect(preview).toHaveAttribute('data-state', 'ready');

  // Place it in a wall experience.
  await createExperience(page, 'Gallery wall', 'Wall');
  const panel = page.getByTestId('image-objects');
  await expect(panel).toContainText('No image objects yet.');
  await panel.getByRole('button', { name: 'Add image object' }).click();
  await panel.getByRole('button', { name: /Add aa_disc_dark_fringe\.png \(30 cm × 30 cm · Blend · front only\)/ }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await expect(panel.getByTestId('placed-image-object')).toHaveCount(1);
  await expect(panel.getByTestId('placed-image-object')).toContainText('30 cm × 30 cm · Blend · front only');
  const url = page.url();
  await page.reload();
  await expect(page.getByTestId('image-objects').getByTestId('placed-image-object')).toHaveCount(1);

  // The source image is protected while the experience uses its image object.
  await page.goto('/library');
  await page.getByRole('button', { name: 'Delete aa_disc_dark_fringe.png' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByRole('alert')).toHaveText('This asset is used by “Gallery wall”. Remove it there first.');

  await page.goto(url);
  await page.getByTestId('image-objects').getByRole('button', { name: 'Remove aa_disc_dark_fringe.png' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await expect(page.getByTestId('image-objects')).toContainText('No image objects yet.');
});

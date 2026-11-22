/**
 * Milestone 5 browser flows in workerd (dev server and production build): uploads stream through the Worker
 * into Miniflare's local R2 simulator; previews load through short-lived signed URLs. Local only — the deployed
 * R2 bucket is not exercised here (TESTING.md).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createExperience, verifiedSignedIn } from './helpers.ts';

const FIX = 'tests/fixtures/images/';
const png = { name: 'poster.png', mimeType: 'image/png', buffer: readFileSync(`${FIX}tracking_target_20cm.png`) }; // 1200×800
const alpha = { name: 'ring.png', mimeType: 'image/png', buffer: readFileSync(`${FIX}ring_inner_hole.png`) };

function glb(): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0', generator: 'e2e' }, meshes: [{}] }).padEnd(52, ' '));
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + json.length, 8);
  head.writeUInt32LE(json.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, json]);
}

async function chooseRole(page: Page, label: string) {
  await page.getByRole('group', { name: 'What is this file for?' }).getByText(label, { exact: true }).click();
}

const loadedImages = (page: Page) =>
  page.locator('[data-testid="asset-card"] img').evaluateAll((imgs) => (imgs as HTMLImageElement[]).map((i) => ({ ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth })));

test('library: upload each role with progress → listed with metadata and a working private preview → delete', async ({ page, request }) => {
  await verifiedSignedIn(page, request, 'm5');
  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { name: 'Asset library' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No assets yet' })).toBeVisible();

  await page.getByTestId('uploader-tracking-image').locator('input[type=file]').setInputFiles(png);
  await expect(page.getByRole('status').filter({ hasText: 'Uploaded poster.png.' })).toBeVisible();
  const card = page.getByTestId('asset-card').filter({ hasText: 'poster.png' });
  await expect(card).toContainText('Tracking image');
  await expect(card).toContainText('1200 × 800 px');

  await chooseRole(page, 'Display image');
  await page.getByTestId('uploader-display-image').locator('input[type=file]').setInputFiles(alpha);
  await expect(page.getByTestId('asset-card').filter({ hasText: 'ring.png' })).toContainText('may have transparency');

  await chooseRole(page, '3D model (GLB)');
  await page.getByTestId('uploader-model').locator('input[type=file]').setInputFiles({ name: 'chair.glb', mimeType: '', buffer: glb() });
  await expect(page.getByTestId('asset-card').filter({ hasText: 'chair.glb' })).toContainText('1 mesh');

  // Previews are served from R2 through signed, cookieless URLs.
  await expect.poll(async () => (await loadedImages(page)).every((i) => i.ok) && (await loadedImages(page)).length).toBe(2);
  expect((await loadedImages(page)).map((i) => i.w).sort()).toEqual([1200, 512]);
  await expect(page.getByTestId('usage')).toHaveText(/KB of 1 GB used/);

  await page.getByRole('button', { name: '3D models' }).click();
  await expect(page.getByTestId('asset-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'All' }).click();

  await page.getByRole('button', { name: 'Delete chair.glb' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByTestId('asset-card')).toHaveCount(2);
});

test('library: rejected files show clear errors (client checks and server signature check)', async ({ page, request }) => {
  await verifiedSignedIn(page, request, 'm5');
  await page.goto('/library');
  const input = page.getByTestId('uploader-tracking-image').locator('input[type=file]');

  await input.setInputFiles({ name: 'photo.webp', mimeType: 'image/webp', buffer: Buffer.from('RIFF0000WEBP') });
  await expect(page.getByRole('alert')).toHaveText('Tracking images must be PNG or JPEG.');

  await input.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(11 * 1024 * 1024) });
  await expect(page.getByRole('alert')).toHaveText(/can be at most 10 MB/);

  // Renamed HTML: passes the client's type check, refused by the server's signature check.
  await input.setInputFiles({ name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('<html><script>alert(1)</script></html>'.padEnd(4096, ' ')) });
  await expect(page.getByRole('alert')).toHaveText('This file is not a PNG or JPEG image.');

  const small = readFileSync(`${FIX}tall_npot.png`); // 101 px wide
  await input.setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: small });
  await expect(page.getByRole('alert')).toHaveText(/at least 256 pixels on the shortest side/);
  await expect(page.getByTestId('asset-card')).toHaveCount(0);
});

test('image experience: upload a tracking image → selected with printed size → readiness updates → persists → protected from deletion', async ({ page, request }) => {
  await verifiedSignedIn(page, request, 'm5');
  const url = await createExperience(page, 'Poster AR', 'Image anchored');
  await expect(page.getByText('Choose a tracking image for image placement.')).toBeVisible();

  const picker = page.getByTestId('tracking-image');
  await picker.locator('input[type=file]').setInputFiles(png);
  await expect(picker.getByTestId('printed-size')).toHaveText('Printed size: 20 × 13.3 cm');
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await expect(page.getByText('Choose a tracking image for image placement.')).toHaveCount(0);

  // Printed width drives the computed height.
  await page.getByLabel('Printed width of the tracking image (cm)').fill('30');
  await expect(picker.getByTestId('printed-size')).toHaveText('Printed size: 30 × 20 cm');
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');

  await page.goto(url);
  await expect(picker.getByTestId('printed-size')).toHaveText('Printed size: 30 × 20 cm');
  await expect(picker.locator('img')).toHaveJSProperty('naturalWidth', 1200);

  await page.goto('/library');
  await page.getByRole('button', { name: 'Delete poster.png' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByRole('alert')).toHaveText('This asset is used by “Poster AR”. Remove it there first.');
  await expect(page.getByTestId('asset-card')).toHaveCount(1);

  // Remove it from the experience; then deletion works.
  await page.goto(url);
  await picker.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await expect(page.getByText('Choose a tracking image for image placement.')).toBeVisible();
  await page.goto('/library');
  await page.getByRole('button', { name: 'Delete poster.png' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByRole('heading', { name: 'No assets yet' })).toBeVisible();
});

test('signed preview URLs work without cookies and refuse tampering; other users cannot see assets', async ({ page, request, browser }) => {
  await verifiedSignedIn(page, request, 'm5');
  await page.goto('/library');
  await page.getByTestId('uploader-tracking-image').locator('input[type=file]').setInputFiles(png);
  const src = await page.getByTestId('asset-card').locator('img').getAttribute('src');
  expect(src).toMatch(/\/api\/assets\/[0-9a-f-]{36}\/content\?v=[0-9a-f]{16}&exp=\d+&sig=/);

  const anonymous = await browser.newContext(); // no session cookie at all (like a native AR viewer)
  const ok = await anonymous.request.get(src!);
  expect(ok.status()).toBe(200);
  expect(ok.headers()['content-type']).toBe('image/png');
  expect(Buffer.compare(await ok.body(), png.buffer)).toBe(0);
  const bad = await anonymous.request.get(src!.replace(/sig=[^&]+/, 'sig=' + 'A'.repeat(43)));
  expect(bad.status()).toBe(403);

  const intruder = await anonymous.newPage();
  await verifiedSignedIn(intruder, anonymous.request, 'm5-intruder');
  await intruder.goto('/library');
  await expect(intruder.getByRole('heading', { name: 'No assets yet' })).toBeVisible();
  const id = /assets\/([0-9a-f-]{36})\//.exec(src!)![1];
  expect((await anonymous.request.get(`/api/assets/${id}`)).status()).toBe(404);
  await anonymous.close();
});

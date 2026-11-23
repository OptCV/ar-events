/**
 * Phase 3 Milestone 9: scene editor workspace — tree, viewport, inspector. Desktop browser only; says nothing about AR.
 * The image objects are converted for real (local Workflow + the converter image in Docker), like image-objects.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createExperience, verifiedSignedIn } from './helpers.ts';

const FIX = 'tests/fixtures/images/';

async function makeImageObject(page: Page, name: string, widthCm: string) {
  await page.goto('/library');
  await page.getByRole('group', { name: 'What is this file for?' }).getByText('Display image', { exact: true }).click();
  await page.getByTestId('uploader-display-image').locator('input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: readFileSync(`${FIX}${name}`) });
  await expect(page.getByRole('status').filter({ hasText: `Uploaded ${name}.` })).toBeVisible();
  await page.getByRole('link', { name: `Make an AR object from ${name}` }).click();
  await page.getByLabel('Real-world width').fill(widthCm);
  await page.getByRole('button', { name: 'Create AR object' }).click();
  await expect(page.getByTestId('io-status')).toHaveText('Your AR object is ready.', { timeout: 30_000 });
}

test('scene editor: add → drawn from its file at its real size → select from tree and 3D view → hide, rename → survives reload → remove', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p3ed');
  await makeImageObject(page, 'ring_inner_hole.png', '40'); // 40 × 40 cm, standing, bottom edge

  await createExperience(page, 'Editor wall', 'Wall');
  const editor = page.getByTestId('scene-editor');
  const viewport = page.getByTestId('viewport');
  await expect(viewport).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(viewport).toHaveAttribute('data-anchor', 'wall');
  await expect(viewport).toHaveAttribute('data-rendered', '');
  await expect(viewport.getByText('3D preview — not AR')).toBeVisible();
  await expect(editor.getByTestId('inspector')).toHaveCount(0);

  await editor.getByRole('button', { name: 'Add image object' }).click();
  await editor.getByRole('button', { name: /Add ring_inner_hole\.png \(40 cm × 40 cm/ }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');

  // Added → selected; drawn from the GLB with its picture; the inspector measures the file: 40 × 40 cm, flat.
  const row = editor.getByTestId('tree-row');
  await expect(row).toHaveCount(1);
  const nodeId = await viewport.evaluate(async (el) => {
    for (let i = 0; i < 100 && !el.getAttribute('data-rendered'); i++) await new Promise((r) => setTimeout(r, 100));
    return el.getAttribute('data-rendered')!;
  });
  expect(nodeId).toMatch(/^io-[0-9a-f]{10}$/);
  await expect(viewport).toHaveAttribute('data-untextured', '');
  await expect(row.getByRole('button', { name: /^ring_inner_hole\.png/ })).toHaveAttribute('aria-pressed', 'true');
  const inspector = page.getByTestId('inspector');
  await expect(inspector.getByTestId('inspector-size')).toHaveText('40 × 40 × 0 cm');
  await expect(inspector.getByTestId('inspector-position')).toHaveText('0, 0, 0 cm');

  // Clicking empty space in the 3D view clears the selection; clicking the object selects it (orbit drags never do).
  await viewport.scrollIntoViewIfNeeded();
  const box = (await viewport.boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + box.height - 20);
  await expect(inspector).toHaveCount(0);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(inspector).toHaveCount(0);
  await editor.getByRole('button', { name: 'Reset view' }).click();
  // The ring stands on the anchor origin (screen centre) and is 40 cm tall: its middle is just above the centre.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - box.height * 0.06);
  await expect(inspector).toBeVisible();

  // Rename and hide: the tree, the 3D view and the saved scene follow.
  await inspector.getByLabel('Name').fill('Big ring');
  await inspector.getByLabel('Name').press('Enter');
  await expect(row).toContainText('Big ring');
  await row.getByRole('button', { name: 'Hide Big ring' }).click();
  await expect(viewport).toHaveAttribute('data-rendered', '');
  await expect(inspector).toContainText('VisibleNo');
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');

  // Roundtrip: what was saved comes back after a reload.
  await page.reload();
  await expect(page.getByTestId('tree-row')).toContainText('Big ring');
  await expect(page.getByTestId('tree-row').getByRole('button', { name: 'Show Big ring' })).toBeVisible();
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-rendered', '');
  await page.getByTestId('tree-row').getByRole('button', { name: 'Show Big ring' }).click();
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-rendered', nodeId, { timeout: 20_000 });

  // The same image object can be placed twice; removing one keeps the other.
  await page.getByTestId('scene-editor').getByRole('button', { name: 'Add image object' }).click();
  await page.getByTestId('scene-editor').getByRole('button', { name: /Add ring_inner_hole\.png/ }).click();
  await expect(page.getByTestId('tree-row')).toHaveCount(2);
  await page.getByTestId('inspector').getByRole('button', { name: 'Remove ring_inner_hole.png' }).click();
  await expect(page.getByTestId('tree-row')).toHaveCount(1);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-rendered', nodeId);
});

test('scene editor: each placement mode draws its anchor; image mode shows the tracking image at its printed size', async ({ page, request }) => {
  await verifiedSignedIn(page, request, 'p3anchor');
  await createExperience(page, 'Floor scene', 'Floor');
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-anchor', 'floor');
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(page.getByTestId('scene-editor')).toContainText('The grid is the floor (10 cm squares)');

  await createExperience(page, 'Poster scene', 'Image anchored');
  const editor = page.getByTestId('scene-editor');
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-anchor', 'image');
  await expect(editor).toContainText('Choose a tracking image to see it here at its printed size.');
  await page.getByTestId('tracking-image').locator('input[type=file]').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: readFileSync(`${FIX}tracking_target_20cm.png`) });
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await expect(editor).toContainText('shown at its printed size (20 × 13.3 cm), lying flat');
  await page.getByLabel('Printed width of the tracking image (cm)').fill('30');
  await expect(editor).toContainText('shown at its printed size (30 × 20 cm), lying flat');
});

test('scene editor: an object added while the tracking image is still uploading is kept (no lost update)', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p3race');
  await makeImageObject(page, 'ring_inner_hole.png', '40');
  await createExperience(page, 'Race poster', 'Image anchored');

  // Hold the upload so the object is added in the middle of it.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/assets/*/content', async (route) => {
    if (route.request().method() === 'PUT') await held;
    await route.continue();
  });
  await page.getByTestId('tracking-image').locator('input[type=file]').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: readFileSync(`${FIX}tracking_target_20cm.png`) });
  const editor = page.getByTestId('scene-editor');
  await editor.getByRole('button', { name: 'Add image object' }).click();
  await editor.getByRole('button', { name: /Add ring_inner_hole\.png/ }).click();
  await expect(editor.getByTestId('tree-row')).toHaveCount(1);
  release();

  await expect(page.getByTestId('tracking-image').getByTestId('printed-size')).toHaveText('Printed size: 20 × 13.3 cm');
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await expect(editor.getByTestId('tree-row')).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('scene-editor').getByTestId('tree-row')).toHaveCount(1);
  await expect(page.getByTestId('tracking-image').getByTestId('printed-size')).toHaveText('Printed size: 20 × 13.3 cm');
});

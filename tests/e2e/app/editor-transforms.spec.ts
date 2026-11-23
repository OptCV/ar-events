/**
 * Phase 3 Milestone 10: transforms, gizmos, lock/duplicate/remove, align commands and undo/redo. Every check reads the
 * SAVED scene back from the API (what gets published), not just the UI. Desktop browser only; says nothing about AR.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ExperienceDetail } from '@ar-creator/contracts';
import { createExperience, makeImageObject, verifiedSignedIn } from './helpers.ts';

const S = Math.SQRT1_2;

async function savedNodes(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  const id = page.url().split('/').pop()!;
  const res = await page.request.get(`/api/experiences/${id}`);
  return ((await res.json()) as ExperienceDetail).draft.scene.nodes;
}

const closeTo = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]!) < eps);

async function addRing(page: Page) {
  const editor = page.getByTestId('scene-editor');
  await editor.getByRole('button', { name: 'Add image object' }).click();
  await editor.getByRole('button', { name: /Add ring_inner_hole\.png/ }).first().click();
  await expect(page.getByTestId('viewport')).not.toHaveAttribute('data-rendered', '', { timeout: 20_000 });
}

async function setFields(page: Page, values: Record<string, string>) {
  const inspector = page.getByTestId('inspector');
  for (const [label, v] of Object.entries(values)) await inspector.getByLabel(label, { exact: true }).fill(v);
  await inspector.getByLabel(Object.keys(values).at(-1)!, { exact: true }).press('Enter');
}

test('transforms: typed values are stored in meters/quaternion/scale, survive reload, and undo/redo step by step', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p3tf');
  await makeImageObject(page, 'ring_inner_hole.png', '40');
  await createExperience(page, 'Transforms', 'Floor');
  await addRing(page);
  const inspector = page.getByTestId('inspector');
  const undoBtn = page.getByRole('button', { name: 'Undo', exact: true });
  const redoBtn = page.getByRole('button', { name: 'Redo', exact: true });

  await setFields(page, { 'Position X': '25', 'Position Z': '-10' });
  await setFields(page, { 'Rotation Y': '90' });
  await setFields(page, { Scale: '50' });
  let [n] = await savedNodes(page);
  expect(n!.transform.position).toEqual([0.25, 0, -0.1]);
  expect(closeTo(n!.transform.rotation, [0, S, 0, S])).toBe(true);
  expect(n!.transform.scale).toEqual([0.5, 0.5, 0.5]);
  await expect(inspector.getByTestId('inspector-size')).toHaveText('20 × 20 × 0 cm'); // the file's 40 cm × 50 %

  // Typed mistakes are explained and nothing is saved.
  await setFields(page, { Scale: '0' });
  await expect(inspector.getByRole('alert')).toHaveText('Scale must be between 1% and 10000%.');
  await setFields(page, { Scale: '50' });

  await page.reload();
  await page.getByTestId('tree-row').getByRole('button', { name: /^ring_inner_hole\.png/ }).click();
  await expect(inspector.getByLabel('Position X', { exact: true })).toHaveValue('25');
  await expect(inspector.getByLabel('Position Z', { exact: true })).toHaveValue('-10');
  await expect(inspector.getByLabel('Rotation Y', { exact: true })).toHaveValue('90');
  await expect(inspector.getByLabel('Scale', { exact: true })).toHaveValue('50');

  // History is per editing session: after a reload there is nothing to undo.
  await expect(undoBtn).toBeDisabled();
  await setFields(page, { 'Position X': '0', 'Position Z': '0' }); // step 1
  await setFields(page, { 'Rotation Y': '0' }); // step 2 (Position X/Z were one step: one Enter)
  await setFields(page, { Scale: '100' }); // step 3
  [n] = await savedNodes(page);
  expect(n!.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

  await undoBtn.click();
  await undoBtn.click();
  [n] = await savedNodes(page);
  expect(n!.transform.position).toEqual([0, 0, 0]);
  expect(closeTo(n!.transform.rotation, [0, S, 0, S])).toBe(true);
  expect(n!.transform.scale).toEqual([0.5, 0.5, 0.5]);
  await redoBtn.click();
  [n] = await savedNodes(page);
  expect(n!.transform.rotation).toEqual([0, 0, 0, 1]);

  // Keyboard: Ctrl+Z / Ctrl+Shift+Z (not while typing in a field).
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  [n] = await savedNodes(page);
  expect(closeTo(n!.transform.rotation, [0, S, 0, S])).toBe(true);
  await page.keyboard.press('Control+Shift+z');
  [n] = await savedNodes(page);
  expect(n!.transform.rotation).toEqual([0, 0, 0, 1]);
  await expect(redoBtn).toBeEnabled(); // step 3 (scale) can still be redone
  await page.keyboard.press('Control+y');
  [n] = await savedNodes(page);
  expect(n!.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  await expect(redoBtn).toBeDisabled();
});

test('lock, duplicate, remove and their shortcuts; undo brings a removed object back', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p3lock');
  await makeImageObject(page, 'ring_inner_hole.png', '40');
  await createExperience(page, 'Locking', 'Floor');
  await addRing(page);
  const inspector = page.getByTestId('inspector');
  const rows = page.getByTestId('tree-row');

  await inspector.getByRole('button', { name: 'Lock' }).click();
  await expect(inspector.getByLabel('Position X', { exact: true })).toBeDisabled();
  await expect(inspector.getByRole('button', { name: /^Remove/ })).toBeDisabled();
  await expect(rows).toContainText('locked');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-tool', 'move');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.getByTestId('tree-row').getByRole('button', { name: /^ring_inner_hole\.png/ }).click();
  await page.keyboard.press('Delete'); // locked: ignored
  await expect(rows).toHaveCount(1);
  expect((await savedNodes(page))[0]!.locked).toBe(true);

  await inspector.getByRole('button', { name: 'Unlock' }).click();
  await page.keyboard.press('Control+d');
  await expect(rows).toHaveCount(2);
  const nodes = await savedNodes(page);
  expect(nodes[1]).toMatchObject({ name: 'ring_inner_hole.png copy', locked: false, transform: { position: [0.1, 0, 0] } });
  expect(nodes[1]!.id).not.toBe(nodes[0]!.id);
  await expect(rows.nth(1).getByRole('button', { name: /^ring_inner_hole.png copy/ })).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Delete');
  await expect(rows).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(rows).toHaveCount(2);
  expect((await savedNodes(page)).map((x) => x.name)).toEqual(['ring_inner_hole.png', 'ring_inner_hole.png copy']);
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
});

test('align: put on floor, flush to wall and fit to the tracking image use the real bounds', async ({ page, request }) => {
  test.setTimeout(150_000);
  await verifiedSignedIn(page, request, 'p3align');
  await makeImageObject(page, 'ring_inner_hole.png', '40'); // 40 × 40 cm, standing on its bottom edge
  const inspector = page.getByTestId('inspector');

  // Floor: upside down and lifted 30 cm → its lowest point is 10 cm below the floor → raised to y = 40 cm.
  await createExperience(page, 'Align floor', 'Floor');
  await addRing(page);
  await setFields(page, { 'Position Y': '30', 'Rotation X': '180' });
  await inspector.getByRole('button', { name: 'Put on floor' }).click();
  await expect(inspector.getByLabel('Position Y', { exact: true })).toHaveValue('40');
  expect((await savedNodes(page))[0]!.transform.position).toEqual([0, 0.4, 0]);

  // Wall: turned 90° about Y the picture sticks 20 cm into the wall → moved out to z = 20 cm.
  await createExperience(page, 'Align wall', 'Wall');
  await addRing(page);
  await setFields(page, { 'Rotation Y': '90' });
  await inspector.getByRole('button', { name: 'Flush to wall' }).click();
  await expect(inspector.getByLabel('Position Z', { exact: true })).toHaveValue('20');

  // Image: 40 cm ring on a 20 cm tracking image → 50 %, centred on the image, resting on it.
  await createExperience(page, 'Align image', 'Image anchored');
  await page.getByTestId('tracking-image').locator('input[type=file]').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: readFileSync('tests/fixtures/images/tracking_target_20cm.png') });
  await expect(page.getByTestId('tracking-image').getByTestId('printed-size')).toHaveText('Printed size: 20 × 13.3 cm');
  await addRing(page);
  await setFields(page, { 'Position X': '7', 'Position Z': '-3' });
  await inspector.getByRole('button', { name: 'Fit to image' }).click();
  await expect(inspector.getByLabel('Scale', { exact: true })).toHaveValue('50');
  await expect(inspector.getByTestId('inspector-size')).toHaveText('20 × 20 × 0 cm');
  const [n] = await savedNodes(page);
  expect(closeTo(n!.transform.position, [0, 0, 0])).toBe(true);
  expect(n!.transform.scale).toEqual([0.5, 0.5, 0.5]);
});

test('gizmo: dragging with the Move tool moves by whole centimetres (snap), as one undo step; Select never moves', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p3giz');
  await makeImageObject(page, 'ring_inner_hole.png', '40');
  await createExperience(page, 'Gizmo', 'Floor');
  await addRing(page);
  const viewport = page.getByTestId('viewport');
  await viewport.scrollIntoViewIfNeeded();
  const box = (await viewport.boundingBox())!;
  const origin = async () => {
    const [x, y] = (await viewport.getAttribute('data-selected-screen'))!.split(',').map(Number);
    return { x: box.x + x!, y: box.y + y! };
  };

  // Select tool: a drag from the object orbits the camera; the object stays where it is.
  let o = await origin();
  await page.mouse.move(o.x, o.y);
  await page.mouse.down();
  await page.mouse.move(o.x + 80, o.y, { steps: 6 });
  await page.mouse.up();
  expect((await savedNodes(page))[0]!.transform.position).toEqual([0, 0, 0]);
  await page.getByRole('button', { name: 'Reset view' }).click();

  // Move tool: drag the centre handle sideways.
  await page.keyboard.press('w');
  await expect(viewport).toHaveAttribute('data-tool', 'move');
  o = await origin();
  await page.mouse.move(o.x, o.y);
  await page.mouse.move(o.x + 1, o.y + 1, { steps: 2 }); // hover selects the handle
  await page.mouse.down();
  await page.mouse.move(o.x + 120, o.y, { steps: 10 });
  await page.mouse.up();
  const moved = (await savedNodes(page))[0]!.transform.position;
  expect(moved[0]).toBeGreaterThan(0.02);
  for (const v of moved) expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6); // whole cm
  await expect(page.getByTestId('inspector').getByLabel('Position X', { exact: true })).toHaveValue(String(Number((moved[0]! * 100).toFixed(2))));

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await savedNodes(page))[0]!.transform.position).toEqual([0, 0, 0]);
});

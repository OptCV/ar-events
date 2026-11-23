/**
 * Phase 3 Milestone 11: 3D models, text, panels and shapes in the editor; per-object and scene budgets. Checks read
 * the SAVED scene back from the API. Desktop browser only; says nothing about how AR viewers will show them.
 */
import { expect, test, type Page } from '@playwright/test';
import type { ExperienceDetail } from '@ar-creator/contracts';
import { createExperience, verifiedSignedIn } from './helpers.ts';
import { cubeGlb, gridGlb } from './glb.ts';

async function savedNodes(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  const id = page.url().split('/').pop()!;
  return ((await (await page.request.get(`/api/experiences/${id}`)).json()) as ExperienceDetail).draft.scene.nodes;
}

const rendered = (page: Page) => page.getByTestId('viewport').evaluate((el) => (el.getAttribute('data-rendered') ?? '').split(',').filter(Boolean).length);

test('3D model: upload from the editor → drawn at its real size with its budget → saved → protected from deletion', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p3model');
  const url = await createExperience(page, 'Model scene', 'Floor');
  const add = page.getByTestId('add-content');
  await add.getByRole('button', { name: 'Add 3D model' }).click();
  await expect(page.getByTestId('model-picker')).toContainText('No 3D models in your library yet.');
  await page.getByTestId('model-picker').locator('input[type=file]').setInputFiles({ name: 'cube.glb', mimeType: 'model/gltf-binary', buffer: cubeGlb(0.3) });

  const inspector = page.getByTestId('inspector');
  await expect(inspector).toContainText('cube.glb');
  await expect(inspector.getByTestId('inspector-size')).toHaveText('30 × 30 × 30 cm', { timeout: 20_000 });
  await expect(inspector.getByTestId('inspector-budget')).toHaveText('12 triangles · 1 material');
  await expect(inspector.getByTestId('inspector-budget-issues')).toHaveCount(0);
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-untextured', ''); // untextured by design, not a failed load
  await inspector.getByText('In AR').click();
  await expect(inspector.getByTestId('in-ar')).toContainText('Converted to USDZ; fidelity must be checked in Quick Look.');

  // A centred cube is half under the floor until put on it.
  await inspector.getByRole('button', { name: 'Put on floor' }).click();
  const [n] = await savedNodes(page);
  expect(n).toMatchObject({ kind: 'model', name: 'cube.glb', transform: { position: [0, 0.15, 0] } });

  // Reusable: a second experience picks it from the library.
  await createExperience(page, 'Model scene 2', 'Wall');
  await page.getByTestId('add-content').getByRole('button', { name: 'Add 3D model' }).click();
  await page.getByTestId('model-picker').getByRole('button', { name: 'Add cube.glb' }).click();
  await expect(page.getByTestId('inspector').getByTestId('inspector-size')).toHaveText('30 × 30 × 30 cm', { timeout: 20_000 });

  await page.goto('/library');
  await page.getByRole('button', { name: 'Delete cube.glb' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByRole('alert')).toContainText('This asset is used by');
  await page.goto(url);
  await expect(page.getByTestId('tree-row')).toContainText('cube.glb');
});

test('budgets: a 125,000-triangle model is flagged on the object and the scene', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p3budget');
  await createExperience(page, 'Heavy scene', 'Floor');
  await page.getByTestId('add-content').getByRole('button', { name: 'Add 3D model' }).click();
  await page.getByTestId('model-picker').locator('input[type=file]').setInputFiles({ name: 'grid.glb', mimeType: 'model/gltf-binary', buffer: gridGlb(250) });
  const inspector = page.getByTestId('inspector');
  await expect(inspector.getByTestId('inspector-budget')).toHaveText('125,000 triangles · 1 material', { timeout: 20_000 });
  await expect(inspector.getByTestId('inspector-budget-issues')).toHaveText('This object has 125,000 triangles; Scene Viewer recommends at most 100,000.');
  await expect(page.getByTestId('scene-budget')).toContainText('The scene has 125,000 triangles; Scene Viewer recommends at most 100,000.');
  // Hidden objects do not count towards the scene.
  await page.getByTestId('tree-row').getByRole('button', { name: 'Hide grid.glb' }).click();
  await expect(page.getByTestId('scene-budget')).not.toContainText('recommends at most 100,000.');
});

test('text, panel and shape: added at the surface, edited, drawn at their real size, saved and reloaded', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p3text');
  await createExperience(page, 'Built-ins', 'Floor');
  const add = page.getByTestId('add-content');
  const inspector = page.getByTestId('inspector');

  // Text: two lines of 10 cm → 20 cm tall; colour from the colour field.
  await add.getByRole('button', { name: 'Add text' }).click();
  await expect(inspector.getByTestId('inspector-size')).toHaveText(/ × 5 × 0 cm$/, { timeout: 20_000 }); // default 5 cm line
  await inspector.getByLabel('Text', { exact: true }).fill('Hello\nAR');
  await inspector.getByLabel('Line height (cm)').fill('10');
  await inspector.getByLabel('Line height (cm)').press('Enter');
  await inspector.getByLabel('Colour').fill('#c0392b');
  await expect(inspector.getByTestId('inspector-size')).toHaveText(/ × 20 × 0 cm$/);
  let nodes = await savedNodes(page);
  expect(nodes[0]).toMatchObject({ kind: 'text', text: 'Hello\nAR', style: { color: '#c0392b', sizeMeters: 0.1 }, transform: { position: [0, 0.025, 0] } });
  await inspector.getByLabel('Text', { exact: true }).fill('');
  await inspector.getByLabel('Line height (cm)').click();
  await expect(inspector.getByRole('alert')).toHaveText('Text cannot be empty.');
  await inspector.getByLabel('Text', { exact: true }).fill('Hello\nAR');

  // Panel: 30 cm wide card.
  await add.getByRole('button', { name: 'Add panel' }).click();
  await expect(inspector.getByTestId('inspector-size')).toHaveText(/^30 × [\d.]+ × 0 cm$/, { timeout: 20_000 });
  await inspector.getByLabel('Title').fill('Opening hours');
  await inspector.getByLabel('Text', { exact: true }).fill('Monday to Friday, 9:00 to 17:00. Closed on public holidays.');
  await inspector.getByLabel('Title').click();

  // Shape: a 20 cm box resting on the floor; then a red sphere.
  await add.getByRole('button', { name: 'Add shape' }).click();
  await expect(inspector.getByTestId('inspector-size')).toHaveText('20 × 20 × 20 cm', { timeout: 20_000 });
  await expect(inspector.getByTestId('inspector-budget')).toHaveText('12 triangles · 1 material');
  await inspector.getByLabel('Shape', { exact: true }).selectOption('sphere');
  await inspector.getByLabel('Colour').fill('#2a8a3e');
  nodes = await savedNodes(page);
  expect(nodes.map((n) => n.kind)).toEqual(['text', 'panel', 'primitive']);
  expect(nodes[1]).toMatchObject({ title: 'Opening hours', body: 'Monday to Friday, 9:00 to 17:00. Closed on public holidays.' });
  expect(nodes[2]).toMatchObject({ shape: 'sphere', color: '#2a8a3e', name: 'Sphere', transform: { position: [0, 0.1, 0], scale: [0.2, 0.2, 0.2] } });
  await expect.poll(() => rendered(page), { timeout: 20_000 }).toBe(3);

  // Locked content cannot be edited.
  await inspector.getByRole('button', { name: 'Lock' }).click();
  await expect(inspector.getByLabel('Shape', { exact: true })).toBeDisabled();
  await inspector.getByRole('button', { name: 'Unlock' }).click();

  // Roundtrip.
  await page.reload();
  await expect(page.getByTestId('tree-row')).toHaveCount(3);
  await expect.poll(() => rendered(page), { timeout: 20_000 }).toBe(3);
  await page.getByTestId('tree-row').getByRole('button', { name: /^Text/ }).click();
  await expect(page.getByTestId('inspector').getByLabel('Text', { exact: true })).toHaveValue('Hello\nAR');
  await expect(page.getByTestId('scene-budget')).toContainText('Scene (visible objects):');
});

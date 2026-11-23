/**
 * Phase 4 Milestone 12: actions in the editor — links, email, phone, show/hide, play animation; tap actions, hotspots,
 * the main button; deletions that never leave dangling references (and say what else went). Checks read the SAVED
 * scene back from the API.
 */
import { expect, test, type Page } from '@playwright/test';
import type { ExperienceDetail } from '@ar-creator/contracts';
import { createExperience, verifiedSignedIn } from './helpers.ts';
import { cubeGlb } from './glb.ts';

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  const id = page.url().split('/').pop()!;
  return ((await (await page.request.get(`/api/experiences/${id}`)).json()) as ExperienceDetail).draft.scene;
}

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

test('actions: create each kind, pick the main button, give an object a tap action; invalid input explained', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p4act');
  await createExperience(page, 'Shop scene', 'Floor');
  const add = page.getByTestId('add-content');
  await add.getByRole('button', { name: 'Add shape' }).click();
  await add.getByRole('button', { name: 'Add text' }).click();
  const panel = page.getByTestId('actions-panel');
  await expect(add.getByRole('button', { name: 'Add hotspot' })).toBeDisabled(); // needs an action first
  await expect(panel.getByLabel('Main button')).toContainText('None');

  // A non-https link is explained, nothing is added.
  await panel.getByRole('button', { name: 'Add action' }).click();
  await panel.getByRole('form', { name: 'New action' }).getByLabel('Web address', { exact: true }).fill('http://example.com');
  await panel.getByRole('form', { name: 'New action' }).getByRole('button', { name: 'Add' }).click();
  await expect(panel.getByRole('alert')).toHaveText('Enter a full web address starting with https://');
  await panel.getByRole('button', { name: 'Cancel' }).click();

  await addAction(page, 'Open a web page', { 'Web address': 'https://example.com/shop', 'Button text (optional)': 'Shop now' });
  await addAction(page, 'Send an email', { 'Email address': 'hello@example.com' });
  await addAction(page, 'Call a phone number', { 'Phone number': '+1 (555) 010-0000' });
  await addAction(page, 'Show or hide an object', { Object: 'Box' });
  const rows = panel.getByTestId('action-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Shop now');
  await expect(rows.nth(0)).toContainText('Open https://example.com/shop');
  await expect(rows.nth(1)).toContainText('Send email');
  await expect(rows.nth(3)).toContainText('Show or hide “Box”');

  // Only web links are offered as the main button.
  const main = panel.getByLabel('Main button');
  await expect(main.locator('option')).toHaveCount(2);
  await main.selectOption({ label: 'Shop now — Open https://example.com/shop' });

  // Tap on the text → email.
  await page.getByTestId('tree-row').getByRole('button', { name: /^Text/ }).click();
  await page.getByTestId('inspector').getByLabel('On tap').selectOption({ label: 'Send email — Email hello@example.com' });
  await expect(rows.nth(1)).toContainText('Used by: tap on “Text”');
  await expect(rows.nth(0)).toContainText('Used by: main button');

  const scene = await saved(page);
  expect(scene.actions.map((a) => a.type)).toEqual(['open-url', 'mailto', 'tel', 'toggle-visibility']);
  expect(scene.actions[0]).toMatchObject({ url: 'https://example.com/shop', label: 'Shop now' });
  expect(scene.actions[2]).toMatchObject({ number: '+1 (555) 010-0000' });
  expect(scene.actions[3]).toMatchObject({ nodeId: scene.nodes[0]!.id });
  expect(scene.primaryActionId).toBe(scene.actions[0]!.id);
  expect(scene.nodes[1]!.actionId).toBe(scene.actions[1]!.id);

  // Editing the main button into an email clears the main button, with a notice; undo restores both.
  await rows.nth(0).getByRole('button', { name: 'Edit Shop now' }).click();
  const form = panel.getByRole('form', { name: 'Edit action' });
  await form.getByLabel('What it does').selectOption({ label: 'Send an email' });
  await form.getByLabel('Email address', { exact: true }).fill('shop@example.com');
  await form.getByRole('button', { name: 'Save action' }).click();
  await expect(page.getByTestId('editor-notice')).toHaveText('This action is no longer the main button: only web links can be.');
  expect((await saved(page)).primaryActionId).toBeUndefined();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const back = await saved(page);
  expect(back.primaryActionId).toBe(back.actions[0]!.id);
  expect(back.actions[0]).toMatchObject({ type: 'open-url', url: 'https://example.com/shop' });

  // Reload keeps everything.
  await page.reload();
  await expect(page.getByTestId('action-row')).toHaveCount(4);
  await expect(page.getByTestId('actions-panel').getByLabel('Main button')).toHaveValue(back.actions[0]!.id);
});

test('deleting never leaves dangling references: actions, hotspots and the objects they target', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p4del');
  await createExperience(page, 'Deletion scene', 'Floor');
  const add = page.getByTestId('add-content');
  const panel = page.getByTestId('actions-panel');
  const inspector = page.getByTestId('inspector');
  await add.getByRole('button', { name: 'Add shape' }).click();
  await addAction(page, 'Show or hide an object', { Object: 'Box' });
  await addAction(page, 'Open a web page', { 'Web address': 'https://example.com/' });
  await panel.getByLabel('Main button').selectOption({ index: 1 });

  // A hotspot gets the first action; it is drawn in the 3D view.
  await add.getByRole('button', { name: 'Add hotspot' }).click();
  await expect(inspector.getByLabel('Action')).toHaveValue((await saved(page)).actions[0]!.id);
  await expect.poll(() => page.getByTestId('viewport').evaluate((el) => (el.getAttribute('data-rendered') ?? '').split(',').filter(Boolean).length), { timeout: 20_000 }).toBe(2);

  // The hotspot's action cannot be deleted while the hotspot needs it.
  await panel.getByRole('button', { name: /^Delete Show or hide/ }).click();
  await expect(page.getByTestId('editor-notice')).toHaveText('Used by “Hotspot”. Give it another action or remove it first.');
  await expect(panel.getByTestId('action-row')).toHaveCount(2);

  // Deleting the main-button link says what it cleared.
  await panel.getByRole('button', { name: 'Delete Visit website' }).click();
  await expect(page.getByTestId('editor-notice')).toHaveText('Action deleted; the experience has no main button now.');
  let scene = await saved(page);
  expect(scene.actions).toHaveLength(1);
  expect(scene.primaryActionId).toBeUndefined();

  // Removing the box removes the action that shows/hides it and the hotspot left without an action — and says so.
  await page.getByTestId('tree-row').getByRole('button', { name: /^Box/ }).click();
  await inspector.getByRole('button', { name: 'Remove Box' }).click();
  await expect(page.getByTestId('editor-notice')).toHaveText('Also removed the action Show or hide “Box” and the hotspot “Hotspot”.');
  scene = await saved(page);
  expect(scene).toMatchObject({ nodes: [], actions: [] });

  // One undo brings all three back together.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  scene = await saved(page);
  expect(scene.nodes.map((n) => n.kind)).toEqual(['primitive', 'hotspot']);
  expect(scene.actions).toHaveLength(1);
  expect(scene.nodes[1]!.actionId).toBe(scene.actions[0]!.id);
});

test('play animation: clips come from the loaded model file', async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifiedSignedIn(page, request, 'p4anim');
  await createExperience(page, 'Animated', 'Floor');
  await page.getByTestId('add-content').getByRole('button', { name: 'Add 3D model' }).click();
  await page.getByTestId('model-picker').locator('input[type=file]').setInputFiles({ name: 'spinner.glb', mimeType: 'model/gltf-binary', buffer: cubeGlb(0.3, 'Spin') });
  await expect(page.getByTestId('inspector')).toContainText('1 (not played in the editor)', { timeout: 20_000 });
  await expect(page.getByTestId('inspector').getByTestId('inspector-size')).toHaveText('30 × 30 × 30 cm');
  await expect(page.getByTestId('inspector').getByTestId('iphone-notes')).toHaveText('Its animation is not included yet; the model is shown still.');
  await addAction(page, 'Play a model animation', { '3D model': 'spinner.glb', Animation: 'Spin' });
  await expect(page.getByTestId('action-row')).toContainText('Play “Spin” on “spinner.glb”');
  const scene = await saved(page);
  expect(scene.actions[0]).toMatchObject({ type: 'play-animation', clip: 'Spin', nodeId: scene.nodes[0]!.id });
});

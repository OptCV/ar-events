/** Shared browser-test helpers (local dev mailbox, local Postgres). */
import { randomBytes } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery staple';
const ip = () => `10.88.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

export async function verifiedSignedIn(page: Page, request: APIRequestContext, prefix = 'e2e'): Promise<string> {
  await page.setExtraHTTPHeaders({ 'cf-connecting-ip': ip() });
  const email = `${prefix}-${randomBytes(5).toString('hex')}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Creator');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  let link = '';
  for (let i = 0; i < 20 && !link; i++) {
    const { messages } = (await (await request.get(`/api/dev/mailbox?to=${encodeURIComponent(email)}`)).json()) as { messages: { text: string }[] };
    link = /https?:\/\/\S+/.exec(messages.at(-1)?.text ?? '')?.[0] ?? '';
    if (!link) await new Promise((r) => setTimeout(r, 250));
  }
  await page.goto(new URL(link).pathname + new URL(link).search);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return email;
}

export async function createExperience(page: Page, name: string, mode: 'Image anchored' | 'Floor' | 'Wall') {
  await page.goto('/experiences/new');
  await page.getByLabel('Name').fill(name);
  await page.getByText(mode, { exact: true }).click();
  await page.getByRole('button', { name: 'Create experience' }).click();
  await expect(page).toHaveURL(/\/experiences\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  return page.url();
}

/** Upload a display image fixture and convert it (real local Workflow + converter image). */
export async function makeImageObject(page: Page, name: string, widthCm: string) {
  const { readFileSync } = await import('node:fs');
  await page.goto('/library');
  await page.getByRole('group', { name: 'What is this file for?' }).getByText('Display image', { exact: true }).click();
  await page.getByTestId('uploader-display-image').locator('input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: readFileSync(`tests/fixtures/images/${name}`) });
  await expect(page.getByRole('status').filter({ hasText: `Uploaded ${name}.` })).toBeVisible();
  await page.getByRole('link', { name: `Make an AR object from ${name}` }).click();
  await page.getByLabel('Real-world width').fill(widthCm);
  await page.getByRole('button', { name: 'Create AR object' }).click();
  await expect(page.getByTestId('io-status')).toHaveText('Your AR object is ready.', { timeout: 90_000 });
}

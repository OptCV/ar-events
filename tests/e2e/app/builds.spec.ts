/**
 * Phase 5 Milestone 16: test builds and the public device test page (ADR-034). The build runs for real (local Workflow
 * + the converter image in Docker). Phone behaviour here is routing only — what Quick Look / Scene Viewer show is
 * checked on devices.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createExperience, verifiedSignedIn } from './helpers.ts';

const PHONES = {
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36',
};

async function addAction(page: Page, type: string, fields: Record<string, string>) {
  const panel = page.getByTestId('actions-panel');
  await panel.getByRole('button', { name: 'Add action' }).click();
  const form = panel.getByRole('form', { name: 'New action' });
  await form.getByLabel('What it does').selectOption({ label: type });
  for (const [label, value] of Object.entries(fields)) await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByRole('button', { name: 'Add' }).click();
}

async function buildFloorScene(page: Page) {
  await createExperience(page, 'Device test', 'Floor');
  await page.getByTestId('add-content').getByRole('button', { name: 'Add shape' }).click();
  await addAction(page, 'Open a web page', { 'Web address': 'https://example.com/shop', 'Button text (optional)': 'Shop now' });
  await addAction(page, 'Send an email', { 'Email address': 'hello@example.com' });
  await page.getByTestId('actions-panel').getByLabel('Main button').selectOption({ index: 1 });
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  const panel = page.getByTestId('test-on-device');
  await panel.getByRole('button', { name: 'Make a test build' }).click();
  await expect(panel.getByTestId('build-status')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  return (await panel.getByTestId('test-link').getAttribute('href'))!;
}

/** A context WITHOUT the creator's session: the signed link is the only credential. */
async function stranger(browser: Browser, userAgent?: string) {
  const ctx = await browser.newContext({ ...(userAgent ? { userAgent, viewport: { width: 390, height: 844 } } : {}) });
  return { ctx, page: await ctx.newPage() };
}

test('test build: editor → ready GLB + USDZ → public test page without signing in (desktop: QR, 3D preview, every link)', async ({ page, request, browser }) => {
  test.setTimeout(150_000);
  await verifiedSignedIn(page, request, 'p5build');
  const link = await buildFloorScene(page);
  const panel = page.getByTestId('test-on-device');
  await expect(panel.getByTestId('build-output-android')).toContainText('Android (GLB): ready');
  await expect(panel.getByTestId('build-output-ios')).toContainText('iPhone and iPad (USDZ): ready');
  await expect(panel.getByTestId('qr-code')).toBeVisible();
  await expect(panel.getByRole('button', { name: /build/i })).toHaveCount(0); // nothing to rebuild: the draft is unchanged
  expect(link).toMatch(/\/test\/[0-9a-f-]{36}\?v=[0-9a-f]{16}&exp=\d+&sig=/);

  const s = await stranger(browser);
  await s.page.goto(link);
  const tp = s.page.getByTestId('test-page');
  await expect(tp.getByRole('heading', { level: 1, name: 'Device test' })).toBeVisible();
  await expect(tp).toContainText('Test build — not published');
  await expect(tp.getByTestId('desktop').getByTestId('qr-code')).toBeVisible();
  await expect(tp.getByTestId('model-preview')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(tp.getByTestId('page-link')).toHaveText(['Shop now', 'Send email']);
  await expect(tp.getByTestId('page-link').nth(1)).toHaveAttribute('href', 'mailto:hello@example.com');
  // A tampered link is refused with an explanation.
  await s.page.goto(link.replace(/sig=[^&]+/, `sig=${'A'.repeat(43)}`));
  await expect(s.page.getByRole('heading', { level: 1 })).toHaveText('This test link no longer works');
  await s.ctx.close();

  // Changing the draft marks the build as stale and offers a new one.
  await page.getByTestId('add-content').getByRole('button', { name: 'Add text' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await page.reload();
  await expect(page.getByTestId('test-on-device')).toContainText('The draft has changed since this build.');
  await expect(page.getByTestId('test-on-device').getByRole('button', { name: 'Build the latest draft' })).toBeEnabled();
});

test('test page on phones: iPhone gets Quick Look with the main button as its banner (tap opens the link); Android needs HTTPS for Scene Viewer', async ({ page, request, browser }) => {
  test.setTimeout(150_000);
  await verifiedSignedIn(page, request, 'p5phone');
  const link = await buildFloorScene(page);
  const origin = new URL(link).origin;

  // iPhone: pretend rel="ar" is supported (as in Safari) and that the site is HTTPS (as on the dev Worker).
  const ios = await stranger(browser, PHONES.ios);
  await ios.page.addInitScript(() => {
    const s = DOMTokenList.prototype.supports;
    DOMTokenList.prototype.supports = function (t: string) {
      return t === 'ar' || s.call(this, t);
    };
  });
  await ios.page.route('**/api/test-builds/*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replaceAll(origin, 'https://ar.example.test') });
  });
  await ios.page.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Shop</h1>' }));
  await ios.page.goto(link);
  const launch = ios.page.getByTestId('launch');
  await expect(launch).toHaveAttribute('rel', 'ar');
  await expect(launch).toHaveAttribute('href', /^https:\/\/ar\.example\.test\/api\/outputs\/[0-9a-f-]{36}\/content\?v=[0-9a-f]{16}&exp=\d+&sig=[A-Za-z0-9_-]{43}#callToAction=Shop%20now$/);
  expect(await launch.evaluate((a) => a.firstElementChild?.tagName)).toBe('IMG');
  // Quick Look reports a banner tap as a message on the anchor; the page then opens the main link.
  await launch.evaluate((a) => a.dispatchEvent(new MessageEvent('message', { data: '_apple_ar_quicklook_button_tapped' })));
  await expect(ios.page).toHaveURL('https://example.com/shop');
  await ios.ctx.close();

  // Android floor: Scene Viewer needs HTTPS for the file and the fallback page; locally (http) it is explained.
  const android = await stranger(browser, PHONES.android);
  await android.page.goto(link);
  await expect(android.page.getByTestId('test-page')).toContainText('AR viewers can only open files from an HTTPS site.');
  await expect(android.page.getByTestId('page-link')).toHaveText(['Shop now', 'Send email']);
  await android.ctx.close();
});

test('Android image placement: the WebXR viewer checks AR support, explains when it is missing (3D preview instead) and reports start errors', async ({ page, request, browser }) => {
  test.setTimeout(150_000);
  const { readFileSync } = await import('node:fs');
  await verifiedSignedIn(page, request, 'p5xr');
  await createExperience(page, 'Poster test', 'Image anchored');
  await page.getByTestId('tracking-image').locator('input[type=file]').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: readFileSync('tests/fixtures/images/tracking_target_20cm.png') });
  await expect(page.getByTestId('tracking-image').getByTestId('printed-size')).toHaveText('Printed size: 20 × 13.3 cm');
  await page.getByTestId('add-content').getByRole('button', { name: 'Add shape' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  const panel = page.getByTestId('test-on-device');
  await panel.getByRole('button', { name: 'Make a test build' }).click();
  await expect(panel.getByTestId('build-status')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await expect(panel.getByTestId('build-output-android')).toContainText('Android (GLB): ready');
  const link = (await panel.getByTestId('test-link').getAttribute('href'))!;

  // A desktop-class browser on an Android UA: no AR sessions → explained, with the flag help and the 3D preview.
  const a = await stranger(browser, PHONES.android);
  await a.page.goto(link);
  const viewer = a.page.getByTestId('xr-viewer');
  await expect(viewer).toHaveAttribute('data-phase', 'unsupported', { timeout: 15_000 });
  await expect(viewer).toContainText('WebXR Incubations');
  await expect(viewer.getByTestId('model-preview')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(a.page.getByTestId('tracking-print')).toContainText('exactly 20 cm wide');
  await a.ctx.close();

  // AR reported as supported, but the session is refused (permission): the reason is shown and Start AR comes back.
  const b = await stranger(browser, PHONES.android);
  await b.page.addInitScript(() => {
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: {
        isSessionSupported: async () => true,
        requestSession: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
      },
    });
  });
  await b.page.goto(link);
  const v2 = b.page.getByTestId('xr-viewer');
  await expect(v2).toHaveAttribute('data-phase', 'ready', { timeout: 15_000 });
  await v2.getByTestId('xr-start').click();
  await expect(v2).toContainText('Camera or AR permission was denied.');
  await expect(v2.getByTestId('xr-start')).toBeEnabled();
  await b.ctx.close();
});

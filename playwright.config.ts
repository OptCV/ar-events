import { defineConfig } from '@playwright/test';

/**
 * Browser suites, using the locally installed Microsoft Edge (Chromium) via `channel` — no browser download.
 * Override with PW_CHANNEL=chrome. Desktop browsers can never prove AR behaviour.
 *
 *  p0           out/p0 device lab (run `npm run p0:build` first)
 *  app-preview  production build served by `vite preview` (Worker + Static Assets in workerd)
 *  app-dev      `vite dev` (Worker in workerd via @cloudflare/vite-plugin)
 */
const channel = process.env.PW_CHANNEL ?? 'msedge';

export default defineConfig({
  timeout: 30_000,
  use: { channel },
  projects: [
    { name: 'p0', testDir: 'tests/e2e/p0', use: { baseURL: 'http://localhost:8787', channel } },
    { name: 'app-preview', testDir: 'tests/e2e/app', use: { baseURL: 'http://localhost:4173', channel } },
    { name: 'app-dev', testDir: 'tests/e2e/app', grepInvert: /@prod-only/, use: { baseURL: 'http://localhost:5180', channel } },
  ],
  webServer: [
    { command: 'node --experimental-strip-types scripts/serve-p0.ts 8787', url: 'http://localhost:8787/', reuseExistingServer: true },
    {
      command: 'npx vite build && npx vite preview --port 4173 --strictPort',
      cwd: 'apps/web',
      url: 'http://localhost:4173/api/health',
      reuseExistingServer: false,
      timeout: 180_000,
    },
    { command: 'npx vite --port 5180 --strictPort', cwd: 'apps/web', url: 'http://localhost:5180/api/health', reuseExistingServer: false, timeout: 120_000 },
  ],
});

import { defineConfig } from '@playwright/test';

/**
 * Browser suites, using the locally installed Microsoft Edge (Chromium) via `channel` — no browser download.
 * Override with PW_CHANNEL=chrome. Desktop browsers can never prove AR behaviour.
 *
 *  p0           out/p0 device lab (run `npm run p0:build` first)
 *  app-preview  production build served by `vite preview` (Worker + Static Assets in workerd)
 *  app-dev      `vite dev` (Worker in workerd via @cloudflare/vite-plugin)
 *  app-db-down  `vite dev` whose Hyperdrive points at a closed port (failure path)
 * The app projects need local Postgres: `npm run db:up && npm run db:migrate`, and Docker for the USD converter.
 */
const channel = process.env.PW_CHANNEL ?? 'msedge';

export default defineConfig({
  timeout: 30_000,
  use: { channel },
  projects: [
    { name: 'p0', testDir: 'tests/e2e/p0', use: { baseURL: 'http://localhost:8787', channel } },
    { name: 'app-preview', testDir: 'tests/e2e/app', use: { baseURL: 'http://localhost:4173', channel } },
    { name: 'app-dev', testDir: 'tests/e2e/app', grepInvert: /@prod-only/, use: { baseURL: 'http://localhost:5180', channel } },
    { name: 'app-db-down', testDir: 'tests/e2e/db-down', use: { baseURL: 'http://localhost:5181', channel } },
  ],
  webServer: [
    // Local USD converter (the Cloudflare Container image; Containers cannot run locally on Windows, ADR-023).
    { command: 'node --experimental-strip-types scripts/usd.ts serve', url: 'http://127.0.0.1:8790/healthz', reuseExistingServer: true, timeout: 300_000 },
    { command: 'node --experimental-strip-types scripts/serve-p0.ts 8787', url: 'http://localhost:8787/', reuseExistingServer: true },
    {
      command: 'npx vite build && npx vite preview --port 4173 --strictPort',
      cwd: 'apps/web',
      url: 'http://localhost:4173/api/health',
      reuseExistingServer: false,
      timeout: 180_000,
    },
    { command: 'npx vite --port 5180 --strictPort', cwd: 'apps/web', url: 'http://localhost:5180/api/health', reuseExistingServer: false, timeout: 120_000 },
    {
      command: 'npx vite --port 5181 --strictPort',
      cwd: 'apps/web',
      url: 'http://localhost:5181/',
      reuseExistingServer: false,
      timeout: 120_000,
      // Overrides the value from .env (process.loadEnvFile does not replace variables that are already set).
      env: { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: 'postgres://nobody:e2e-fake-password-never-real@127.0.0.1:1/none' },
    },
  ],
});

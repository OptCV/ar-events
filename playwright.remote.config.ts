import { defineConfig } from '@playwright/test';

/**
 * Remote authentication suite against the ISOLATED dev Worker (ADR-020). Run ONLY via
 *   npm run db:remote -- remote-auth-test --env development --host <neon dev host> --base-url https://ar-creator-dev.<sub>.workers.dev
 * which seeds a temporary verified user and supplies REMOTE_* through the child-process environment.
 * Serial, single worker: the suite deliberately stays within the 5/min sign-in limit before testing it.
 */
const baseURL = process.env.REMOTE_BASE_URL;
if (!baseURL) throw new Error('Run via `npm run db:remote -- remote-auth-test …` (REMOTE_BASE_URL missing).');

export default defineConfig({
  testDir: 'tests/remote',
  timeout: 45_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { baseURL, channel: process.env.PW_CHANNEL ?? 'msedge', ignoreHTTPSErrors: false },
});

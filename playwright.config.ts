import { defineConfig } from '@playwright/test';

/**
 * Desktop browser tests of the P0 device lab served from out/p0 (run `npm run p0:build` first).
 * Uses the locally installed Microsoft Edge (Chromium) via `channel`, so no browser download is needed;
 * override with PW_CHANNEL=chrome. These tests can never prove AR behaviour — desktop has no AR runtime.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:8787', channel: process.env.PW_CHANNEL ?? 'msedge' },
  webServer: {
    command: 'node --experimental-strip-types scripts/serve-p0.ts 8787',
    url: 'http://localhost:8787/',
    reuseExistingServer: true,
  },
});

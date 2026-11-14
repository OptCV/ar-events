import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Auth/API integration tests against LOCAL Docker Postgres (DATABASE_URL from the gitignored repo-root .env).
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url).href));
} catch {
  // packages/db/test/helpers.ts throws an actionable error
}

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 30_000, hookTimeout: 60_000 },
});

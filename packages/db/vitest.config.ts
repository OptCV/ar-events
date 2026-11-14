import { defineConfig } from 'vitest/config';

// Integration tests against the LOCAL Docker Postgres (DATABASE_URL from the gitignored repo-root .env).
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // handled in test/helpers.ts with an actionable error
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: true,
  },
});

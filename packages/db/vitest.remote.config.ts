import { defineConfig } from 'vitest/config';

// Remote (Neon) verification. Run ONLY via `npm run db:remote -- verify --env <env>`, which supplies the
// connection string through the child-process environment. Does not load the local .env.
export default defineConfig({
  test: {
    include: ['test-remote/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    fileParallelism: false,
  },
});

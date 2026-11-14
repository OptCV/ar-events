// Used only by `npm run auth:generate` (Better Auth CLI) to emit the Drizzle schema. No DB connection is made.
import { drizzle } from 'drizzle-orm/node-postgres';
import { createAuth } from './src/auth.ts';

export const auth = createAuth(drizzle.mock() as never, {
  BETTER_AUTH_SECRET: 'schema-generation-only-not-a-secret-000000',
  BETTER_AUTH_URL: 'http://localhost',
});

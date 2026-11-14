/**
 * Used ONLY by `npm run db:auth-schema` (Better Auth CLI) to generate src/schema/auth.ts. Not shipped.
 * Keep the table-affecting options identical to the runtime config added in Milestone 3 (apps/api):
 * email+password, email verification (uses the core `verification` table), database rate limiting.
 * No database connection is made; the secret below is a non-secret placeholder required by the constructor.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/node-postgres';

export const auth = betterAuth({
  secret: 'schema-generation-placeholder-not-a-secret-0000',
  baseURL: 'http://localhost',
  database: drizzleAdapter(drizzle.mock(), { provider: 'pg' }),
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  rateLimit: { enabled: true, storage: 'database' },
  telemetry: { enabled: false },
});

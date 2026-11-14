import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';

export interface AuthEnv {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  TRUSTED_ORIGINS?: string;
}

/**
 * Factory, NOT a module-scope singleton: Workers forbid I/O objects across requests, and the pg client
 * (via Hyperdrive) is created per request. Better Auth's Cloudflare guide warns that a module-scope instance
 * cannot hold a pg client "even through Hyperdrive"; a per-request instance avoids that.
 */
export function createAuth(db: NodePgDatabase<typeof schema>, env: AuthEnv) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.TRUSTED_ORIGINS ? env.TRUSTED_ORIGINS.split(',') : [],
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true },
    // Memory storage is per-isolate on Workers → useless; persist counters in Postgres.
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      // Workers do not set X-Forwarded-For; without this, rate limiting uses one shared bucket per path.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

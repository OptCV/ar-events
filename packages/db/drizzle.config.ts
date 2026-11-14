import { defineConfig } from 'drizzle-kit';

/**
 * DATABASE_URL must point at the LOCAL Docker database (set in the gitignored repo-root .env by `npm run db:env`).
 * Production (Neon) migrations are run only with the product owner's explicit approval — see DECISIONS.md ADR-017.
 */
process.loadEnvFile?.(new URL('../../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Run `npm run db:env` (local) — never commit connection strings.');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url },
  strict: true,
  verbose: false,
});

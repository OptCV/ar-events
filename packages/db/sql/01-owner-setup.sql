-- Step 1 — run ONCE per Neon branch as the database owner (e.g. neondb_owner), via the Neon SQL Editor.
-- Prerequisite: roles `ar_migrator` and `ar_app` exist. Create them in the Neon Console (Branch → Roles) so Neon
-- generates and stores the passwords; never type passwords into SQL, files or shell history.
-- Idempotent. No secrets in this file.

-- Environment marker checked by `npm run db:remote` before any migration. On the PRODUCTION branch use 'production'.
-- Neon's neondb_owner is not a superuser, so `ALTER DATABASE … SET ar.environment` fails with 42501; use a comment,
-- which the database owner may always set and every role may read. Set it explicitly on every branch.
-- COMMENT ON DATABASE neondb IS 'AR Creator database. ar.environment=development';

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO ar_migrator', current_database()); -- CREATE: drizzle schema
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ar_app', current_database());
END
$$;

GRANT USAGE, CREATE ON SCHEMA public TO ar_migrator;
GRANT USAGE ON SCHEMA public TO ar_app;
REVOKE CREATE ON SCHEMA public FROM ar_app;

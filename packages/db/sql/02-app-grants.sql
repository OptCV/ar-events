-- Step 2 — run as `ar_migrator` (the role that owns the schema objects). Applied automatically by
-- `npm run db:remote -- migrate` after migrating; idempotent. Gives `ar_app` (the role Hyperdrive uses)
-- data access only: no DDL, no ownership, read-only on the migration journal (for /api/health).

ALTER DEFAULT PRIVILEGES FOR ROLE ar_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ar_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ar_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ar_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ar_app;

CREATE SCHEMA IF NOT EXISTS drizzle;
GRANT USAGE ON SCHEMA drizzle TO ar_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ar_migrator IN SCHEMA drizzle GRANT SELECT ON TABLES TO ar_app;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ar_app;

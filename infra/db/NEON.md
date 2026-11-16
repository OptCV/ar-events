# Neon runbook — roles, migrations, verification (ADR-018)

Nothing here is automated by CI or the deploy path. **Remote migrations run only after explicit owner approval.**
No step below puts a password or connection string in Git, a file, a command line, chat, or shell history.

## Current state (verified 2026-11-15 with `wrangler hyperdrive get`, read-only)

| Hyperdrive config | ID | Neon endpoint | Branch | Caching | Origin role |
|---|---|---|---|---|---|
| `ar-creator-db` | `8de2df3d333b4a1b9b07c18fbdd49d18` | `ep-plain-unit-bcruyo1j` | **production** (parent) | disabled ✔ | `neondb_owner` ⚠ |
| `ar-creator-db-dev` | `f7b30d814f184296bb44518058778789` | `ep-weathered-resonance-bce5rdkp` | **development** (child of production) | disabled ✔ | `neondb_owner` ⚠ (→ `ar_app`, step 8) |

Both use direct (non-pooler) endpoints in AWS us-east-1, database `neondb`.

**2026-11-15 incident:** the development branch's `neondb_owner` connection string was pasted into a chat session. The owner reset that role's password on the development branch the same day. Neon copies roles to child branches; whether passwords are copied is not documented. Treat production's `neondb_owner` password as possibly exposed: rotate it after production Hyperdrive moves to `ar_app` (production change, needs approval).

## Role model

| Role | Created by | Used by | Rights |
|---|---|---|---|
| `neondb_owner` | Neon | you, for one-time setup only | database owner; member of `neon_superuser` |
| `ar_migrator` | **SQL**, via `db:remote create-roles` | `db:remote migrate` only | owns every schema object; no superuser/createdb/createrole/bypassrls |
| `ar_app` | **SQL**, via `db:remote create-roles` | Hyperdrive → Worker | SELECT/INSERT/UPDATE/DELETE; read-only migration journal; no DDL |

**Why not the Neon Console?** Neon's docs: roles created in the Console, API or CLI are administrator roles with `neon_superuser` (CREATEDB, CREATEROLE, BYPASSRLS, `pg_read_all_data`, `pg_write_all_data`, ALL on `public` WITH GRANT OPTION). Limited roles must be created with SQL. Neon rejects pre-hashed passwords (so `psql \password` does not work), and typing `PASSWORD '…'` in the SQL Editor would leave it in query history. `create-roles` sends the password once from a hidden prompt, then resets `pg_stat_statements` where permitted.

Rehearsed locally with real roles in Docker (`packages/db/test/roles.test.ts`, 10/10; `create-roles` guard and happy-path rehearsal).

## Steps for the development branch

1. ✅ **Identify branches** (done 2026-11-15; see the table above).
2. ✅ **Reset the development `neondb_owner` password** (done 2026-11-15, after the chat exposure).
3. ✅ **Create the restricted roles** (done 2026-11-15; first Console-created roles had `neon_superuser` and were deleted). In your password manager, generate two different passwords (≥ 24 characters; letters, digits and symbols; no quotes, backslashes or spaces). Then:
   ```sh
   npm run db:remote -- create-roles --env development
   ```
   Paste, at the hidden prompts: the development branch's **direct** `neondb_owner` connection string (Neon → Connect → branch *development*, role `neondb_owner`, pooling **off**); then each new password twice. Type the endpoint ID `ep-weathered-resonance-bce5rdkp` to confirm. The tool refuses if the roles already exist and prints only role attributes (expect all `false` and `member_of=[]`).
4. **Owner grants + environment marker** (no secrets, so the SQL Editor is fine). Neon SQL Editor → branch **development** → database `neondb`:
   - ✅ grants (done 2026-11-15; the `DO` block form did not execute in the SQL Editor, so plain statements were used):
     `GRANT CONNECT, CREATE ON DATABASE neondb TO ar_migrator; GRANT CONNECT ON DATABASE neondb TO ar_app; GRANT USAGE, CREATE ON SCHEMA public TO ar_migrator; GRANT USAGE ON SCHEMA public TO ar_app; REVOKE CREATE ON SCHEMA public FROM ar_app;`
   - marker as a **database comment**. `ALTER DATABASE … SET ar.environment` fails on Neon with `permission denied to set parameter` (42501) because `neondb_owner` is not a superuser:
     ```sql
     COMMENT ON DATABASE neondb IS 'AR Creator database. ar.environment=development';
     ```
5. ✅ **Read-only preflight** (done 2026-11-15; prefer `--host ep-weathered-resonance-bce5rdkp.c-16.us-east-1.aws.neon.tech`, which asks only for the password and URL-encodes it):
   ```sh
   npm run db:remote -- status --env development
   ```
   Paste the **direct** connection string for `ar_migrator` (build it from the `neondb_owner` one by replacing the user and password, or use Neon → Connect → role `ar_migrator`). Expect endpoint `ep-weathered-resonance-bce5rdkp`, role `ar_migrator`, `ar.environment development`, TLS true, `0/2 applied`.
6. ✅ **Apply migrations — only after the owner approves** (approved and done 2026-11-15, 2/2):
   ```sh
   npm run db:remote -- migrate --env development
   ```
   Type `development` to confirm. Applies `0000_initial_schema`, `0001_immutability_triggers`, then `02-app-grants.sql`.
7. ✅ **Verify as the runtime role** (done 2026-11-15, 8/8):
   ```sh
   npm run db:remote -- verify --env development
   ```
   Paste the direct connection string for `ar_app`. Eight checks; all writes are rolled back.
8. ✅ **Point `ar-creator-db-dev` at `ar_app`** (done 2026-11-15 via dashboard; confirmed read-only: user `ar_app`, caching disabled, endpoint development). Use the Cloudflare dashboard (Workers & Pages → Hyperdrive → `ar-creator-db-dev` → Edit origin user and password) so the password never touches a shell. Keep caching **disabled**.

## Production (later, each step needs explicit approval)

Same steps with `--env production` and `--approved` on `create-roles` and `migrate`, `ar.environment = 'production'` on the production branch, then switch `ar-creator-db` to `ar_app` and rotate production's `neondb_owner` password. Record each approval (who, when, what) in `PROGRESS.md` first.

## Avoiding secrets in shell history and chat

- Use the hidden prompts. If you inject `AR_REMOTE_*_URL` / `AR_NEW_*_PASSWORD`, do it from a secret manager (e.g. `op run -- npm run db:remote …`), never `export X=…` by hand.
- Never paste passwords or connection strings into chat or tickets. Endpoint IDs, branch names, role names and Hyperdrive IDs are not secrets.
- The tool never prints connection strings or passwords; database errors are redacted before display.
- `.env` and `apps/web/.dev.vars` are for the **local Docker** database only. Never put Neon credentials in them.

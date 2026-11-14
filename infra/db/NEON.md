# Neon runbook — roles, migrations, verification (ADR-018)

Nothing here is automated by CI or the deploy path. **Remote migrations run only after explicit owner approval.**
No step below puts a password or connection string in Git, a file, a command line or shell history.

## Current state (verified 2026-11-14 with `wrangler hyperdrive get`, read-only)

| Item | Value | Status |
|---|---|---|
| Hyperdrive config | `ar-creator-db` / `8de2df3d333b4a1b9b07c18fbdd49d18` | ✔ |
| Query caching | `disabled: true` | ✔ verified |
| Origin | Neon `us-east-1`, direct endpoint `ep-plain-unit-bcruyo1j`, database `neondb` | ✔ direct (non-pooler) |
| Origin role | `neondb_owner` (full owner) | ⚠ replace with `ar_app` (step 7) |
| Which branch is `ep-plain-unit-bcruyo1j`? | unknown to Cloudflare | ❓ owner to confirm |

## Role model

| Role | Used by | Rights |
|---|---|---|
| `neondb_owner` | you, in the Neon SQL Editor, for one-time setup | database owner |
| `ar_migrator` | `npm run db:remote -- migrate` only | creates and owns all schema objects |
| `ar_app` | Hyperdrive → Worker at runtime | SELECT/INSERT/UPDATE/DELETE only; no DDL; read-only on the migration journal |

Rehearsed locally with real roles in Docker (`packages/db/test/roles.test.ts`, 10/10).

## Steps for the development branch

1. **Identify the branch.** The Hyperdrive endpoint is `ep-plain-unit-bcruyo1j` (note the digit **1** before `j`). Either:
   - Neon Console → project → **Branches** → open each branch → *Computes* shows its endpoint ID; or
   - Neon CLI (interactive browser login, no secrets typed): `npx neonctl auth`, then `npx neonctl branches list --project-id <your-project-id>` and `npx neonctl endpoints list --project-id <your-project-id>` (endpoints list their `branch_id`).

   If it is the **development** branch, keep that Hyperdrive config for development. If it is **production** (often the `main` branch), create a separate development Hyperdrive config (caching disabled) pointing at the development branch's direct endpoint, and keep production untouched until approved. Either way, the `ar.environment` marker (step 3) is what `db:remote` actually enforces.
2. **Create roles** on the development branch: Branch → Roles → *New role* → `ar_migrator`, then again for `ar_app`. Neon shows each generated password once; store both in your password manager. Do not create roles with SQL `PASSWORD '…'` (that puts the password in query history).
3. **Owner setup** — Neon SQL Editor, development branch, database `neondb`, role `neondb_owner`:
   ```sql
   ALTER DATABASE neondb SET ar.environment = 'development';
   ```
   then paste and run `packages/db/sql/01-owner-setup.sql`. Branches copy this setting from their parent, so set `'production'` on the production branch the same way.
4. **Check the target (read-only):**
   ```sh
   npm run db:remote -- status --env development
   ```
   When prompted, paste the **direct** connection string for `ar_migrator` (Neon → Connect → role `ar_migrator`, *Connection pooling* **off**, it ends in `sslmode=require`). Input is hidden. The command prints only the endpoint ID, database, role, environment marker, TLS and pending migrations.
5. **Apply migrations — only after the owner approves:**
   ```sh
   npm run db:remote -- migrate --env development
   ```
   Refuses unless: the role is `ar_migrator`, `ar.environment` = `development`, TLS is on and the endpoint is direct. Asks you to type `development` to confirm. Applies `0000_initial_schema`, `0001_immutability_triggers`, then `02-app-grants.sql`.
6. **Verify as the runtime role:**
   ```sh
   npm run db:remote -- verify --env development
   ```
   Paste the direct connection string for `ar_app`. Runs 8 checks (environment marker, non-superuser without DDL, TLS, migrations current, DDL denied, session create/lookup/expire/revoke, triggers, no residue). All writes are rolled back.
7. **Point Hyperdrive at `ar_app`.** Use the Cloudflare dashboard (Workers & Pages → Hyperdrive → `ar-creator-db` → Edit) so the password is never typed into a shell. Keep caching **disabled**. If `ep-plain-unit-bcruyo1j` is production, create a separate development Hyperdrive config instead, also with caching disabled.

## Production

Same steps with `--env production`, `ar.environment = 'production'`, and `--approved` on `migrate`. Record the approval (who, when, which migrations) in `PROGRESS.md` before running it.

## Avoiding secrets in shell history

- Prefer the hidden prompt. If you inject `AR_REMOTE_MIGRATOR_URL` / `AR_REMOTE_APP_URL`, do it from a secret manager (e.g. `op run -- npm run db:remote …`), not by typing `export X=…`.
- The tool never prints connection strings; database errors are redacted before display.
- `.env` is for the **local Docker** database only. Never put Neon credentials in it.

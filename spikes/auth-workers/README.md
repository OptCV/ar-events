# Spike: Better Auth on Cloudflare Workers (Hono + Drizzle + pg via Hyperdrive)

Throwaway verification for ADR-013. Not part of the app workspace (own `package.json`/lockfile). Requires Node ≥ 22 and Docker.

```sh
cd spikes/auth-workers
npm install
npm run verify        # Postgres in Docker + `wrangler dev` (workerd) + 16 HTTP checks → verify-result.json
node bench-hash.mjs   # CPU proxy for Better Auth's scrypt (native node:crypto, as bundled for workerd)
```

What it proves (local workerd, 2026-11-14): migrations from the official CLI-generated schema; sign-up, duplicate rejection, wrong-password 401,
sign-in with an HttpOnly SameSite=Lax cookie, protected route, 12 concurrent requests without cross-request I/O errors, hashed password at rest,
server-side revocation on sign-out, and per-`CF-Connecting-IP` rate limiting persisted in Postgres.

What it does **not** prove: behaviour on Cloudflare's edge (real Hyperdrive pooling and **query caching**, CPU accounting, cold starts),
Secure cookies over HTTPS, email verification or password reset (no email provider configured).

Key pattern (`src/index.ts`): per request, create `new pg.Client(env.HYPERDRIVE.connectionString)` → `drizzle(client)` → `createAuth(db, env)`,
and close the client with `executionCtx.waitUntil(client.end())`. Never hold a client or an auth instance bound to one at module scope.

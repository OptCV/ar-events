# DECISIONS.md — Architecture Decision Record (append-only)

Accepted decisions may be superseded by new numbered entries; never rewrite previous decisions in a way that obscures history. Each new record should include date, context, decision, alternatives, tradeoffs and test implications.

## ADR-001 — Vite / Hono / Cloudflare-first stack

**Date:** 2026-11-14  
**Status:** Accepted by product requirements.  
**Decision:** Vite + React + TS + CSS Modules frontend; Hono in Workers; PostgreSQL + Drizzle + Hyperdrive; R2; Workflows/Queues; isolated OpenUSD conversion container. No Next.js or Tailwind.  
**Rationale:** Matches product owner's explicit stack and Cloudflare focus.  
**Consequence:** Heavy Python/USD tasks require a separate processing runtime and real resource feasibility tests.

## ADR-002 — Platform × placement runtime mapping

**Date:** 2026-11-14  
**Status:** Accepted by product requirements.  
**Decision:** iOS all three modes use USDZ/Quick Look; Android image uses native experimental WebXR image tracking only; Android floor and wall use Scene Viewer, with `enable_vertical_placement=true` for wall.  
**Rationale:** Optimize non-image Android AR for native Scene Viewer while preserving experimental browser image tracking.  
**Consequence:** Different interaction capabilities; one central capability registry and fallbacks are mandatory.

## ADR-003 — Distinct image tracking vs image display assets

**Date:** 2026-11-14  
**Status:** Accepted by product requirements.  
**Decision:** A tracking image is an anchor reference. A display image can be converted into GLB/USDZ as a real-scaled textured AR plane, with alpha preserved. They may originate from the same upload but have distinct typed roles and derived records.  
**Rationale:** Prevent confusing invisible tracking references with visible 3D scene artifacts.  
**Consequence:** Implement image-to-AR converter, alpha tests and platform-compatible materials.

## ADR-004 — One canonical scene, immutable published outputs

**Date:** 2026-11-14  
**Status:** Accepted design direction.  
**Decision:** Store versioned scene JSON; compile native outputs separately and publish immutable revision assets behind one stable public URL.  
**Rationale:** Prevent platform drift and avoid breaking a live experience during edits.  
**Consequence:** Typed schema, per-platform compiler and idempotent workflows required.

## ADR template

### ADR-XXX — Short title

**Date:** YYYY-MM-DD  
**Status:** Proposed / Accepted / Superseded  
**Context:** ...  
**Decision:** ...  
**Alternatives:** ...  
**Consequences:** ...  
**Verification:** ...

## ADR-005 — Canonical anchor frame and shared image-quad contract

**Date:** 2026-11-14  
**Status:** Accepted (axis assumptions pending device verification)  
**Context:** The specs require deterministic conversion from the editor frame to USD, WebXR and Scene Viewer but never define the frame, and the wall/image axis conventions of Quick Look, Scene Viewer and Chrome WebXR are not documented precisely enough to rely on.  
**Decision:** Canonical frame is right-handed, +Y up, meters, quaternion `[x,y,z,w]` (glTF convention). Floor: origin on plane, +Y normal. Wall: origin on plane, +Z is the wall normal toward the viewer, +Y world up. Image: origin at target center, +Y image normal, +X image right, +Z image bottom. Image-to-AR quads: `upright` = XY plane facing +Z; `flat` = XZ plane facing +Y with image top toward −Z. glTF UV origin top-left; USD `st = (u, 1 − v)`. `tests/fixtures/geometry_golden.json` is the shared GLB/USD contract; both converters are tested against it.  
**Alternatives:** Per-runtime authoring frames (rejected: drift); USD Z-up (rejected: needless conversions).  
**Consequences:** No per-runtime axis correction is applied yet. Hypotheses H1 (Quick Look vertical-plane content frame = canonical wall frame), H2 (Scene Viewer vertical placement puts the model's −Z against the wall) and H3 (ARKit and Chrome image poses match the canonical image frame) must be confirmed with the P0 orientation probe; if any fails, add the correction in the runtime compiler only and record a new ADR.  
**Verification:** Automated: golden geometry tests (TS + Python). Device: P0 cases `img-overlay`, `floor-probe`, `wall-probe` — **NOT TESTED**.

## ADR-006 — Development toolchain

**Date:** 2026-11-14  
**Status:** Accepted  
**Context:** pnpm and Python are not installed on the primary dev machine; Node 24 and Docker are. TypeScript 7 (native port) is the current npm `latest`.  
**Decision:** npm workspaces; TypeScript 5.9.3 with `erasableSyntaxOnly` (scripts run via Node type-stripping); Vitest 4.1; workspace packages export TS source (no build step until apps need bundling); `zod` 4. Python/OpenUSD runs only in the `services/usd-processor` Docker image (python 3.12-slim, `usd-core==26.8`), never on the host.  
**Alternatives:** pnpm via corepack (fine later; avoids an extra global prerequisite now); TypeScript 7 (revisit once the Vite/Vitest/Wrangler ecosystem has confirmed compatibility).  
**Consequences:** Contributors need Node ≥ 22 and Docker. Exact versions pinned in `package.json`/`requirements.txt`.

## ADR-007 — Runtime identifiers and support vocabulary

**Date:** 2026-11-14  
**Status:** Accepted  
**Context:** `MASTER_PROMPT.md` §8 lists five runtimes (`ios_quicklook_plane`) and statuses `supported|fallback`; `CAPABILITIES.md` lists six runtimes and `native|compiled_visual|fallback_page|experimental|unsupported|verify`.  
**Decision:** Use the six runtimes and the `CAPABILITIES.md` vocabulary (it is the more specific, source-of-truth document). Editor badges map: native→“native”, compiled_visual→“compiled visual”, fallback_page→“fallback landing page”, experimental→“experimental”, unsupported→“unsupported”, verify→“needs device check”. Implemented in `packages/platform-launch` (`RUNTIMES`, `resolveRuntime`) and `packages/capabilities`.  
**Consequences:** Floor and wall iOS outputs are tracked separately (they differ in anchoring metadata and in device results).

## ADR-008 — USDZ structural validation without `usdchecker --arkit`

**Date:** 2026-11-14  
**Status:** Accepted  
**Context:** The spec requires `usdzip`/`usdchecker`. The pip `usd-core` 26.x ships neither CLI and has removed the Python `ComplianceChecker`; Apple's `usdchecker` runs only on macOS.  
**Decision:** Package with `UsdUtils.CreateNewARKitUsdzPackage` (the API behind `usdzip --arkitAsset`). Validate with every registered `UsdValidation` validator plus an explicit Quick Look profile in `usd_processor/validate.py`. Read applied schemas from authored `apiSchemas` metadata because Apple's preliminary schemas are unregistered (`GetAppliedSchemas()` silently hides them — found by a failing test).  
**Alternatives:** Pin an older usd-core that still has `ComplianceChecker` (rejected: older toolchain for a checker that is itself deprecated); macOS CI runner with Apple `usdchecker` (recommended additional gate, not yet available).  
**Consequences:** "Structurally validated" ≠ "device verified". Negative tests prove the validator rejects zip-renamed USDZ, missing textures and broken anchors.

## ADR-009 — Image-to-AR texture policy: embed original bytes

**Date:** 2026-11-14  
**Status:** Accepted  
**Context:** Alpha must survive both conversions; any decode/re-encode risks premultiplication, flattening, gamma or halo bugs.  
**Decision:** For PNG and JPEG (EXIF orientation = 1), embed the uploaded bytes unmodified in GLB and USDZ; tests assert SHA-256 equality. Alpha mode is decided once (TS `resolveAlphaMode`) and passed to the USD processor. Texture sampler uses CLAMP_TO_EDGE.  
**Consequences:** WebP (not core glTF, not allowed in USDZ) and EXIF-rotated JPEGs must be normalized to PNG/JPEG by a lossless, alpha-preserving step before conversion — **pending**, currently rejected by `readImageInfo`. Large uploads may need a downscaled derivative for viewer texture limits — pending.

## ADR-010 — Android WebXR image-tracking adapter and probe

**Date:** 2026-11-14  
**Status:** Accepted (device behavior NOT TESTED)  
**Context:** Android image mode must use native, experimental WebXR image tracking only, isolated behind a capability adapter, with honest fallbacks. Chrome exposes it only behind the "WebXR Incubations" flag, and the deployed API shape may differ from the draft.  
**Decision:** `packages/webxr-image` holds all runtime logic, framework-free and unit-tested: `buildSessionInit` (`local` required; `image-tracking` and `dom-overlay` *optional*, so a session that starts without tracking can be told apart from no AR at all); `resolveImageTrackingApi` (implements exactly one shape, Chrome's `trackedImages` / `getTrackedImageScores` / `getImageTrackingResults`; `marker-tracking` or a partial API → `unrecognized-api`, never guessed); `preflight` with a 4 s timeout (`isSessionSupported` hung in headless Chromium); `ImageAnchorTracker` (per-frame results → state machine scanning/tracked/emulated/lost with 15-frame hysteresis → composed pose → visibility, plus measured-width stats). Rendering stays in the app (three.js). The tracking bitmap and GLB are preloaded so `requestSession` runs synchronously inside the tap handler and keeps transient user activation. The probe (`apps/p0-webxr-probe`, vanilla TS + three.js, built by Vite into `out/p0/webxr/`) reuses `img-overlay.glb` and draws an axis helper to test H3.  
**Alternatives:** React for the probe (deferred: the probe is a P0 harness; the public runtime in `apps/web` will consume the same package); JS image trackers (forbidden by ADR-002).  
**Consequences:** The public Android image viewer can reuse the adapter and tracker unchanged. Desktop e2e tests can only cover the unsupported path; tracking itself is only provable on device (AND-IMG-01).

## ADR-011 — Byte-reproducible USDZ packages

**Date:** 2026-11-14  
**Status:** Accepted  
**Context:** Rebuilding the P0 kit changed every USDZ SHA-256 with identical inputs. Cause: `UsdUtils` packaging stamps ZIP entries with wall-clock time. The in-process determinism test missed it because both builds ran in the same second.  
**Decision:** After packaging, overwrite the DOS time/date of every local and central-directory entry with 1980-01-01 00:00. These fields are fixed-width and not covered by the CRC, so alignment and checksums are unchanged (`usd_processor/reproducible.py`). A regression test builds 2.1 s apart and re-validates.  
**Consequences:** Asset hashes in `manifest.json` / device evidence are stable across rebuilds, as content-addressed derivative keys (DATA_MODEL.md R2 layout) require.

## ADR-012 — Device evidence rules from the first WebXR device run

**Date:** 2026-11-14  
**Status:** Accepted  
**Context:** The first AND-IMG-01 report (Chrome 157) proved the native image-tracking runtime path, but showed that (a) `measuredWidthInMeters` returned exactly the registered width on all 478 samples, (b) the reduced User-Agent ("Android 10; K", "Chrome/157.0.0.0") cannot identify the device, and (c) the report could not capture visual correctness or tracking loss.  
**Decision:** (1) A UA-reported width that equals the registered width is never size evidence; `WidthStats` flags `echoesRegistered` / `usableAsSizeEvidence`, and physical size is verified only by human observation against a ruler-measured print. (2) Device identity in evidence comes from User-Agent Client Hints (`model`, `platformVersion`, `fullVersionList`), or else is recorded manually; it is never used for routing. (3) Visual results (alignment, orientation, H3 axes, re-acquire, stability, flag state) are explicit tester fields in the report; unfilled fields mean NOT VERIFIED. (4) Raw per-frame UA state counts are recorded so tracking loss can be diagnosed. Probe bumped to 0.2.0.  
**Alternatives:** Estimate physical size from camera geometry (rejected: complex, not needed for P0); trust UA width (rejected: proven to echo).  
**Consequences:** AND-IMG-01 is PARTIAL until re-run with probe 0.2.0. Routing (ADR-002) is unchanged: Android image remains experimental native WebXR only, `experimental` in the capability registry.  
**Verification:** Regression tests use the exact device values (`webxrImage.test.ts`, "AND-IMG-01 findings").

## ADR-013 — Authentication: Better Auth on Workers with Drizzle + Postgres via Hyperdrive

**Date:** 2026-11-14  
**Status:** Accepted for Phase 1 (verified in local workerd; edge behaviour NOT VERIFIED)  
**Context:** P1 needs creator authentication and ownership checks on Hono/Workers with PostgreSQL. The specs did not name a provider; the product owner asked to evaluate Better Auth.  
**Evaluation (spike `spikes/auth-workers`, better-auth 1.7.14, hono 4.13.14, drizzle-orm 0.45.4, pg 8.23.1, wrangler 4.156.0):**
- Runs in workerd (`wrangler dev`): **16/16** end-to-end checks passed (see `spikes/auth-workers/README.md`, `TESTING.md`).
- Official guidance reconciled: Better Auth's Cloudflare guide says a *module-scope* instance cannot hold a `pg` client even through Hyperdrive; Cloudflare recommends `pg` (node-postgres) with Drizzle over Hyperdrive and a new client per request (Postgres.js + Drizzle over Hyperdrive is unsupported). Resolution: create the `pg` client **and** the auth instance per request; close via `waitUntil(client.end())`. 12 concurrent requests showed no cross-request I/O errors.
- Password hashing: the bundled path is native `node:crypto` scrypt (N=16384, r=16, p=1, dkLen=64; `workerd` export condition confirmed in the built bundle). Measured ≈ 37 ms per hash (Node, same native implementation, local CPU). Free-plan Workers allow 10 ms CPU per request; Paid allows 30 s by default.
- Rate limiting: in-memory storage is per isolate and unsuitable; Workers KV cannot satisfy `secondaryStorage` (no atomic ops, min 60 s TTL, per Better Auth). `storage: "database"` works and is keyed by `CF-Connecting-IP` (`advanced.ipAddress.ipAddressHeaders`).
- Telemetry is opt-in (disabled by default); set `telemetry: { enabled: false }` explicitly.

**Decision:**
1. Better Auth (pin exact versions) with `@better-auth/drizzle-adapter` (`provider: "pg"`); schema generated by the Better Auth CLI, migrated with drizzle-kit alongside app tables.
2. Per-request `pg.Client` over a Hyperdrive binding + per-request `createAuth(db, env)` factory; no module-scope DB-bound state.
3. Email + password first. Email verification and password reset are required before public launch but blocked on an email-provider decision. OAuth/passkeys later as plugins.
4. **Workers Paid plan is required** for the API Worker (scrypt exceeds the Free 10 ms CPU cap). Do not weaken the hash to fit Free limits. Set `limits.cpu_ms` to a modest guard (e.g. 5 000) once edge measurements exist.
5. **Hyperdrive query caching must not serve auth/session reads.** Create the Hyperdrive config with caching disabled (or use a separate no-cache binding for auth and authorization queries); otherwise a revoked session may remain valid until the cache entry expires. Verify on the edge.
6. Same-origin deployment (ADR-014): first-party `HttpOnly; Secure; SameSite=Lax` cookies; `trustedOrigins` = own origin only; no credentialed CORS. Our own state-changing API routes additionally require an `Origin` check and a JSON content type.
7. Secrets: `BETTER_AUTH_SECRET` via `wrangler secret put`; local `.dev.vars` (gitignored, random per developer). Client IP from `CF-Connecting-IP`.

**Alternatives:** Auth.js (heavier, framework-centric); Lucia (deprecated by its author); managed IdPs such as Clerk/Auth0/Cognito (no CPU concern, but vendor lock-in, cost and data residency); Cloudflare Access (suits internal staff, not public creators); custom auth (rejected: security surface).  
**Consequences:** Ownership checks hang off `auth.api.getSession`. App tables reference the Better Auth `user.id` (text); DATA_MODEL.md's `users` table maps to Better Auth's `user` table (no duplicate users table).  
**Verification still required (P1-3):** deploy to a Paid Workers account with a real Hyperdrive config: sign-in CPU time in Workers Observability, revocation with caching disabled, Secure cookie attributes over HTTPS, cold-start latency.

## ADR-014 — Single Worker serving SPA and API (same origin)

**Date:** 2026-11-14  
**Status:** Proposed — verify in P1-1  
**Context:** Cookie auth, CSP and Scene Viewer/Quick Look asset URLs are simplest with one origin. Specs require Workers Static Assets and the Cloudflare Vite plugin.  
**Decision:** One deployable Worker: the Vite/React SPA (`apps/web`) served as static assets with SPA fallback, and the Hono API (`apps/api`) handling `/api/*`, built with `@cloudflare/vite-plugin`. Public published assets are served from R2 under immutable keys (same origin or a dedicated asset hostname; decide in P1-5).  
**Alternatives:** Separate API and web origins (needs credentialed CORS and cross-site cookie handling); Cloudflare Pages + Functions (superseded by Workers Static Assets).  
**Verification:** P1-1 must show `vite dev` running both SPA and Worker in workerd, and a production build with `/api/*` routed to the Worker and other paths to the SPA.

## ADR-015 — Phase 1 service choices (product owner approval)

**Date:** 2026-11-14  
**Status:** Accepted by product owner  
**Decision:** Neon PostgreSQL (preferably US East) with Drizzle ORM, reached from Workers only through Cloudflare Hyperdrive; Better Auth (ADR-013); Resend for email verification and password recovery; Workers **Paid** plan in production; Cloudflare R2 for storage. Uploads start Worker-streamed for small assets, but the upload service interface must also support presigned URLs and R2 multipart uploads for large 3D models. One Worker serves the SPA and the API from the same origin (ADR-014 → accepted, verification in P1 Milestone 1). Hyperdrive query caching is disabled for authentication, sessions, permissions and other consistency-sensitive reads (ADR-013 §5).  
**Constraints restated:** no secrets, connection strings or API keys in Git (Wrangler secrets, `.dev.vars` locally); public sign-up stays disabled until email verification and security configuration are complete; platform routing (ADR-002) unchanged.  
**Consequences:** Phase 1 runs as five sequential milestones (skeleton → database → authentication → experience management → asset storage), each verified and committed separately.

## ADR-016 — Phase 1 Milestone 1: application skeleton conventions

**Date:** 2026-11-14  
**Status:** Accepted (local verification; not yet deployed)  
**Context:** Milestone 1 sets up the single same-origin Worker (ADR-014) and the conventions later milestones will follow.  
**Decision:**
1. **Layout:** `apps/web` owns the deployable unit (`vite.config.ts` + `wrangler.jsonc`, `main: ../api/src/worker.ts`); `apps/api` holds the Hono app as a plain package (`createApp`) so it is unit-testable in Node; `packages/contracts` holds Zod request/response schemas shared by Worker and SPA.
2. **Routing:** `assets.not_found_handling = "single-page-application"` and `assets.run_worker_first = ["/api/*"]`. Unknown `/api/*` paths return the JSON error contract, never `index.html`. Unknown non-API paths (including missing static files) return `index.html` with 200.
3. **Types per runtime:** separate tsconfigs for the Worker (types from `wrangler types`, no DOM) and the SPA (DOM + `vite/client`). The generated `worker-configuration.d.ts` is not committed; `pretypecheck` regenerates it from `wrangler.jsonc`.
4. **Security defaults:** SPA headers in `public/_headers` (strict CSP without `unsafe-inline`, `frame-ancestors 'none'`, nosniff, Referrer-Policy, restrictive Permissions-Policy); API responses use Hono `secureHeaders` with `default-src 'none'` and `Cache-Control: no-store`; errors return `{ error: { code, message, requestId } }` without internals. **No client source maps** are deployed (they would be public assets); Worker source maps are uploaded privately (`upload_source_maps`).
5. **Build identity:** `/api/health` reports the package version, the git commit (`-dirty` when uncommitted) and the runtime (`workerd` detected via `navigator.userAgent`).
6. **Dependencies:** Hono pinned to 4.13.16, deliberately newer than the two-week settling rule, because ≤4.13.15 has five published advisories, including wildcard middleware being skipped. Security fixes override the settling rule. The auth spike still pins 4.13.14 and is reference-only.
7. **Tests:** Vitest for API logic (Node); Playwright projects run against `vite dev` and `vite preview` (production build), both in workerd, using the local Edge channel.

**Consequences:** ADR-014's same-origin routing is verified locally in workerd (dev and production build). It is **not yet verified on Cloudflare's edge**: the first deploy must confirm `run_worker_first`, `_headers` and SPA fallback behave identically.

## ADR-017 — Database layer: Drizzle schema, migrations and per-request Hyperdrive connections

**Date:** 2026-11-14  
**Status:** Accepted (verified locally against Docker PostgreSQL 17 and in workerd; Neon/Hyperdrive on the edge NOT verified; production migrations NOT applied)  
**Context:** Milestone 2 (ADR-015): Neon PostgreSQL (AWS US East) through Hyperdrive config `8de2df3d333b4a1b9b07c18fbdd49d18`, which the owner created with query caching disabled.  
**Decision:**
1. **`packages/db`** owns the Drizzle schema, migrations and connection code. Better Auth tables (`user`, `session`, `account`, `verification`, `rate_limit`) are generated by the Better Auth CLI (`npm run db:auth-schema`, better-auth 1.7.16, the first release without the 2026-11-03 advisories) from a config that mirrors the Milestone 3 runtime options. The schema is identical to the one the auth spike verified. Better Auth's `user` table *is* the users table (ADR-013). App tables: `experiences`, `experience_revisions`, `assets`, `asset_derivatives`, `processing_jobs`, `generated_outputs`.
2. **Integrity in the database, not only in code:** owner FKs with cascades; composite FKs so an experience's draft/published pointers can only reference its own revisions; a published revision cannot be deleted; one draft per experience (partial unique index); slug/name/SHA-256/R2-prefix/attempt CHECKs; unique idempotency keys and derivative provenance. Enum values are imported from the TypeScript sources (`AssetRole`, `RUNTIMES`) and tested for equality. **Triggers** (custom migration `0001`) make frozen revisions' content immutable and stop them returning to `draft`, and make `ready` outputs/derivatives' storage identity immutable.
3. **Migrations** are version-controlled SQL from drizzle-kit (`packages/db/migrations`), applied by `drizzle-kit migrate`. A test fails if the TypeScript schema has changes not captured in a migration. **Production migrations run only with explicit owner approval** (procedure in `PROGRESS.md`); nothing in the build or deploy path applies them.
4. **Connections:** `connectDb()` opens one `pg` client per Worker request via `env.HYPERDRIVE.connectionString` (5 s connect timeout, 10 s `statement_timeout`, `application_name=ar-creator`). The API middleware connects lazily (routes that do not use the DB never connect) and closes via `waitUntil`. Verified: 30 concurrent requests leave 0 open connections.
5. **Consistency:** the single `HYPERDRIVE` binding has caching disabled, so **all** reads (auth, sessions, permissions, drafts) are consistent. If caching is ever wanted, it goes on a *separate* binding used only for immutable published content, never for auth or permissions.
6. **Secrets:** no credentials in Git, `wrangler.jsonc`, logs or bundles. Local credentials are random per developer in the gitignored `.env` (`npm run db:env`), used by Docker, drizzle-kit, tests and the Cloudflare Vite plugin (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`). DB error details are redacted before logging. `/api/health` exposes only coarse categories. Tests scan browser responses and the full build output for the real password and any credentialed URL (proven by a planted-secret check).
7. **Health:** `/api/health` returns `checks.database` (`status`, `latencyMs`, `migrations: current|behind|ahead|unknown`, `error` category) and HTTP 503 `degraded` when the DB is unavailable or migrations are behind.
8. **Tooling security:** drizzle-kit's transitive `esbuild@0.18` (advisory GHSA-67mh-4wv8-2f99, dev-server only) is overridden to `esbuild@0.25.12` for `@esbuild-kit/core-utils`; `npm audit` is clean and drizzle-kit generate/migrate were re-verified.

**Alternatives:** Neon serverless HTTP driver (bypasses Hyperdrive; rejected by ADR-015); a module-scope pool (forbidden in Workers); CHECKs/triggers only in application code (rejected: bypassable).  
**Consequences / follow-ups:** recommend separate Neon roles (a migration owner and a least-privilege DML role used by Hyperdrive). `/api/health` opens a DB connection per call, so add rate limiting or brief caching before public launch. Migration 0001 uses PL/pgSQL, which Neon supports.

## ADR-018 — Neon role model and guarded remote migrations

**Date:** 2026-11-14  
**Status:** Accepted (rehearsed locally with real roles; NOT yet applied to Neon; awaiting owner actions and approval)  
**Context:** `wrangler hyperdrive get` (read-only) confirmed config `ar-creator-db` has caching **disabled**, but connects as `neondb_owner` (full owner) to endpoint `ep-plain-unit-bcruyo1j` (us-east-1, direct). Which Neon branch that endpoint belongs to is not visible from Cloudflare.  
**Decision:**
1. Three roles: `neondb_owner` (one-time setup only), `ar_migrator` (runs migrations and owns every schema object), `ar_app` (runtime role for Hyperdrive: SELECT/INSERT/UPDATE/DELETE only, read-only on the migration journal, no DDL). SQL: `packages/db/sql/01-owner-setup.sql` (as owner) and `02-app-grants.sql` (as `ar_migrator`, idempotent, applied automatically after migrating). Roles are created in the Neon Console so passwords never appear in SQL or shell history.
2. Every branch carries a database-level marker `ar.environment` (`development` or `production`), set by the owner. `npm run db:remote -- status|migrate|verify --env <env>` refuses to act unless the marker matches. It also refuses pooled endpoints, non-TLS remote connections, migrating as any role other than `ar_migrator`, production without `--approved`, and any run without a typed confirmation. Connection strings come from a hidden prompt (or secret-manager-injected env vars), are never printed or written, and errors are redacted.
3. `verify` runs the runtime-role suite (`packages/db/test-remote/runtime-role-suite.ts`) as `ar_app`. All writes are inside transactions that are rolled back. The same suite is rehearsed locally against Docker with real roles (`packages/db/test/roles.test.ts`).
4. After migrating, the Hyperdrive origin is switched to `ar_app` through the Cloudflare dashboard (no secrets in a shell). Caching stays disabled.

**Consequences:** The runbook is `infra/db/NEON.md`. Nothing remote runs automatically.  
**Verification:** Local rehearsal 10/10. Guard refusals were exercised locally (owner role, production without approval, marker mismatch, wrong confirmation, pooler, no TLS). Neon itself: **NOT VERIFIED**.

## ADR-019 — Milestone 3 authentication (Better Auth in the single Worker)

**Date:** 2026-11-14  
**Status:** Accepted (verified locally in Node and workerd against Docker Postgres; NOT verified on Neon/Hyperdrive or Cloudflare)  
**Decision:**
1. **Better Auth 1.7.16** (all published advisories fixed; `@better-auth/core` pinned by override to the same version after a skew to 1.7.25 left the adapter unable to resolve core). One auth instance per request, on that request's pg connection (ADR-013). Email + password, `requireEmailVerification`, no auto sign-in, passwords 12–128 characters, 1-hour single-use email tokens, all sessions revoked on password reset, 7-day sessions refreshed daily, **cookie cache off** (every check reads the database, so sign-out and revocation are immediate). Database-backed rate limits keyed by `CF-Connecting-IP`: sign-in 5/min, sign-up 5/h, reset requests 3/15 min, verification resends 3/15 min, reset submits 5/15 min, default 60/min. Telemetry off.
2. **Cookies:** `arc.session_token`, HttpOnly, SameSite=Lax, Path=/; over HTTPS `__Secure-` prefix + Secure. The session token is **stripped from JSON bodies**: Better Auth returns it for bearer clients, but this app uses only the cookie, so page scripts can never read it.
3. **Exposure:** only the endpoints the app uses are reachable under `/api/auth/*` (everything else Better Auth ships returns 404). Our API adds `GET /api/auth-config` (public UI capabilities), `GET /api/session` (public; `user` or `null`, avoiding 401 noise) and `GET /api/me` (protected; 401 without a session). `requireSession` protects future endpoints.
4. **Fail-closed configuration:** `APP_ENV` defaults to production. A missing or short secret, or a missing/non-https `BETTER_AUTH_URL` in production, makes every auth endpoint return 503. Sign-up requires `AUTH_SIGNUP_ENABLED=true` **and** working email; `wrangler.jsonc` ships with sign-up off and an empty URL. Local values live in the gitignored `apps/web/.dev.vars` (`npm run dev:env`, random 48-byte secret).
5. **Email:** a `Mailer` interface. `ResendMailer` uses fetch, an idempotency key and a 10 s timeout, and its errors never contain the key. `DevMailbox` keeps messages in isolate memory, exposed at `/api/dev/mailbox` only when `APP_ENV=development`, the transport is `dev-mailbox` **and** the host is localhost. Templates escape HTML and only link to our own origin.
6. **Security findings fixed (regression-tested):**
   - (a) **Reset-token leak / account takeover:** with 1.7.16 a `redirectTo` of `https://evil.example` was accepted, and the genuine reset email then redirected the victim to the attacker's site with a valid token. Fix: redirect parameters must be same-site paths in bodies and email-link queries, and any auth response redirecting off-origin is refused.
   - (b) **Open redirect** on email verification (same fix).
   - (c) **Login CSRF:** Better Auth's origin check only covers cookie-bearing requests, so a cookieless cross-site sign-in succeeded. Fix: every non-GET API request, including `/api/auth/*`, needs `Origin` equal to the app origin and a JSON body.
   - Duplicate sign-ups return Better Auth's normal-looking response without creating an account or sending email (anti-enumeration). Password-reset requests answer identically for unknown emails.
7. **UI:** React pages for sign-in, sign-up (shows "not open yet" when disabled), check-inbox with resend, email-confirmed, forgot and reset password, and an account page. `RequireAuth` route guard with a safe `next` redirect. Header is session-aware. Auth state comes from TanStack Query over `/api/session`, and the whole query cache is cleared on sign-out. Shared Zod contracts validate forms with field-linked errors and focus management.

**Alternatives:** Better Auth client SDK (`better-auth/react`): not needed for a same-origin cookie app and would expose bearer tokens. Relaxed limits in development: rejected, as tests instead use distinct client IPs.  
**Remaining verification:** a deployed (preview) Worker with Neon via Hyperdrive as `ar_app`, covering Secure cookies over HTTPS, CF-Connecting-IP set by the edge (locally workerd trusts a client-supplied header), sign-in CPU time on the Paid plan, revocation consistency through Hyperdrive, and real Resend delivery.

## ADR-020 — Isolated dev Worker for remote authentication tests; Neon setup findings

**Date:** 2026-11-15  
**Status:** Accepted. Verified 2026-11-15: NEON-DEV-01 PASS; `ar-creator-dev` deployed with owner approval; REMOTE-AUTH-01 9/9  
**Context:** Remote verification of Milestone 3 needs a real Worker on Cloudflare's edge using Hyperdrive and Neon, without any path to production.  
**Decision:**
1. **Separate Worker `ar-creator-dev`** (Wrangler `env.dev`), not a preview version of `ar-creator`, which would inherit production bindings. It binds only `HYPERDRIVE` → `ar-creator-db-dev` (`f7b30d81…`, Neon development branch, role `ar_app`, caching disabled), runs production-strict (`APP_ENV=production`, HTTPS origin, `__Secure-` cookies), and keeps sign-up off. It is reachable only on its `workers.dev` URL. The owner chose a public URL over Cloudflare Access.
2. **`npm run deploy:dev -- --subdomain <s> [--dry-run]`** builds it cleanly and refuses unless: the name is right; the Hyperdrive binding is exactly the dev config; the production Hyperdrive ID appears nowhere; sign-up is off; local `.dev.vars` files are removed from the output; and no value from `apps/web/.dev.vars` or `.env` occurs anywhere in the output. The operator must type the Worker name. **Finding:** the Cloudflare Vite plugin copies `.dev.vars` (with the local `BETTER_AUTH_SECRET`) into `dist/<worker>/` for `vite preview`. This is now stripped and scanned before every deploy; the scan was proven with a planted secret.
3. **`npm run db:remote -- remote-auth-test --env development --host <neon dev host> --base-url https://ar-creator-dev.<s>.workers.dev`** connects as `ar_app`. It seeds one temporary verified user (random in-memory password, hashed with Better Auth's `hashPassword`), runs `tests/remote` (health via Hyperdrive, static headers, sign-up closed, sign-in/cookie flags, immediate revocation, revoke-all, real-browser sign-in, CSRF/allowlist/redirect guards, and that a spoofed `CF-Connecting-IP` cannot bypass rate limiting), then always deletes the user. It refuses production and any other URL.
4. **Neon findings (2026-11-15):**
   - Console-created roles inherit `neon_superuser`, so roles are created with SQL via `db:remote create-roles` (hidden password prompts, attribute verification).
   - `ALTER DATABASE … SET ar.environment` is denied to `neondb_owner` (42501), so the marker is a database comment; both forms are accepted and a conflict refuses.
   - `pg_stat_ssl` reports `false` behind Neon's proxy, so TLS is checked client-side (encrypted and certificate verified) with `sslmode=verify-full`.
   - The SQL Editor did not execute the `DO` block, so the grants were run as plain statements.
   - `--host` mode builds and URL-encodes connection strings so only passwords are entered.
5. **Incident:** the development `neondb_owner` connection string was pasted into chat. The password was reset on the development branch. Production's `neondb_owner` may share it (branch copy); rotate it after production Hyperdrive moves to `ar_app` (needs approval).

**Verification:** NEON-DEV-01 PASS; REMOTE-AUTH-01 PASS 9/9 (`TESTING.md`). Edge finding: Cloudflare rejects client-supplied `CF-Connecting-IP` with 403 error 1000, so the rate-limit key cannot be spoofed.

## ADR-021 — Experience management API, drafts and placement changes (Milestone 4)

**Date:** 2026-11-15  
**Status:** Accepted (verified locally; not yet migrated to Neon or deployed to `ar-creator-dev`)  
**Decision:**
1. **Routes** (`apps/api/src/experiences/routes.ts`), all behind `requireSession`, 256 KB body limit, CSRF guard (Origin; JSON for POST/PUT/PATCH; Origin-only for DELETE):
   - `GET /api/experiences`, `POST /api/experiences`;
   - `GET/PATCH/DELETE /api/experiences/:id`;
   - `PUT /api/experiences/:id/draft` (scene configuration API);
   - `POST /api/experiences/:id/validate` (publish readiness).
2. **Ownership in SQL:** every query filters `owner_id = session user`. Another user's experience, a deleted one and a malformed ID all return **404** (never 403), so existence is not leaked.
3. **Draft vs publishable scene:** `DraftExperienceScene` (`packages/schema`) shares every integrity rule with `ExperienceScene` (one function), but image placement may lack its tracking target until uploads exist (Milestone 5). `publishReadiness()` reports blocking errors and warnings. Publishing (strict schema) is a later milestone.
4. **Optimistic concurrency:** migration `0002_draft_version` adds `experiences.draft_version`. Saves must send the version they loaded. The update is conditional (`WHERE draft_version = $v`), so concurrent writers get exactly one success and the rest **409 `stale_draft`** with the current version. The UI shows "changed in another tab" and offers "Load the latest version". Edits typed during an in-flight save are queued, never lost. Autosave runs after an 800 ms pause.
5. **Placement changes are reviewed, never silent:** `planPlacementChange()` keeps every node and action, lists what is removed (tracking image / printed width) and explains orientation effects. The UI shows it in a confirmation dialog, and the API rejects a mode change without `confirmPlacementChange: true` (**409 `placement_change_unconfirmed`**). The denormalised `experiences.placement_mode` is updated in the same transaction as the draft.
6. **Create** inserts the experience and draft revision 1 (default scene for the chosen mode) in one transaction. The slug is derived from the name plus a random suffix, with retry on collision. `public` visibility is refused until publishing exists.
7. **UI:** `/dashboard` (list, search, empty/loading/error states), `/experiences/new` (details + accessible placement radio group with per-platform runtimes and the Android image "Experimental" badge), `/experiences/:id` (placement, image printed width, scene summary, readiness panel, details, delete with confirmation), all behind `RequireAuth`. The default destination after sign-in is now `/dashboard`.

**Consequences:** the Neon development branch needs migration 0002 (owner approval) and `ar-creator-dev` a redeploy before Milestone 4 can be verified remotely. Asset ownership checks for scene references arrive with assets (Milestone 5).

## ADR-022 — Asset storage in R2: upload slots, streamed validation, signed private reads (Milestone 5)

**Date:** 2026-11-22  
**Status:** Accepted (verified locally, including the R2 adapter in workerd against Miniflare's R2 simulator; no Cloudflare bucket created, nothing deployed)  
**Decision:**
1. **Two-step upload, strategy-neutral contract.** `POST /api/assets/uploads` reserves a slot: a `pending_upload` asset row with a server-generated key `users/{userId}/assets/{assetId}/original` and a 15-minute expiry. It returns an upload target `{strategy, method, url, headers, expiresAt, maxBytes}`. Only `worker-stream` exists today (`PUT /api/assets/:id/content` through the Worker, ADR-015). `presigned-put` and `multipart` are reserved values, so switching to direct-to-R2 uploads later needs no client contract change. Storage sits behind an `ObjectStore` interface (`r2Store`, `memoryStore`); routes never touch R2 directly.
2. **One attempt per slot.** The PUT claims the slot atomically (`upload_claimed_at`, conditional UPDATE). A concurrent second PUT, a retry after failure or an expired slot gets **409 `upload_not_pending`**, and the client starts a new upload. Failed attempts are recorded as `rejected` with a `rejection_code`. Migration `0003_asset_uploads` adds `upload_expires_at`, `upload_claimed_at`, `rejection_code` and two CHECKs (a pending upload needs an expiry; a rejection needs a code).
3. **Validate while streaming; commit only valid files.** A TransformStream between the request body and R2 holds back the first bytes (1 MiB for images, 2 MiB for GLB) until the head is inspected, so **no byte reaches storage before the file signature is checked**. It then counts bytes (they must equal the declared size, which must equal `Content-Length`), hashes every byte (SHA-256; native `crypto.DigestStream` in workerd), and at the end checks the PNG end marker and the optional client checksum. Any failure errors the stream, so the R2 put aborts and nothing is stored; a failed overwrite never damages an existing object (both verified in workerd). When the client declares a checksum, R2 verifies it too.
4. **What is checked.** The declared type is never trusted: the real type comes from magic bytes and must match it.
   - `tracking-image` and `display-image` accept PNG and JPEG. WebP is refused with a clear message until ADR-009 normalisation exists.
   - Dimensions are read from headers before any decode: ≤ 8192 px per edge and ≤ 64 MP (decompression-bomb guard).
   - Tracking images need ≥ 256 px on the shortest side and get a warning below 480 px or beyond a 4:1 aspect ratio.
   - `model` accepts **self-contained GLB 2.0 only**: the header length must equal the file size, the JSON chunk must parse, `asset.version` must be 2.x, and every buffer/image `uri` must be an embedded base64 `data:` URI. **External, relative, `file:` and remote references are refused.** Required glTF extensions produce a warning.
   - JPEG trailers are not checked, because many cameras append data after the end marker.
   - Limits: tracking 10 MB, display 15 MB, model 25 MB; 10 unfinished slots and 1 GiB stored per user (serialised per user with an advisory lock).
   - Roles `usdz-override` and `audio` are not accepted yet.
5. **Signed, cookieless private reads.** Native AR viewers fetch without cookies, so `GET /api/assets/:id/content?v&exp&sig` is authorised by an HMAC-SHA256 over (asset id, content SHA-256, expiry).
   - The key is derived from `BETTER_AUTH_SECRET` with HKDF and a dedicated label (domain separation; no new secret to manage).
   - URLs live 15 minutes (hard cap 24 h) and are bound to the content hash. Verification is constant-time (`crypto.subtle.verify`).
   - Responses carry the stored (validated) MIME type, `nosniff`, `default-src 'none'`, `Content-Disposition: inline` with a server-generated filename, and `Cache-Control: private, max-age ≤ remaining`.
   - The bucket has no public access, and there is no other read path.
6. **Ownership and references.**
   - Every session route filters by owner in SQL, so another user's asset is a 404.
   - Draft saves now verify every referenced asset: it must be owned, validated and in the right role (tracking target → `tracking-image`, model node → `model`, image object → a ready derivative).
   - Deleting an asset referenced by any revision of the owner's experiences returns **409 `asset_in_use`**, naming the experiences.
   - Deletion hides the row, then removes the R2 object, then deletes the row. A storage failure therefore never leaves a visible asset without bytes, or an object with no row pointing at it.
7. **CSRF:** the binary PUT is the single exception to the "JSON body for POST/PUT/PATCH" rule; the Origin check still applies to it.
8. **Bindings:** `ASSETS_BUCKET` → `ar-creator-assets` (production) and `ar-creator-assets-dev` (`env.dev`; bindings are not inherited). `deploy:dev` refuses any other R2 binding. Neither bucket exists yet.
9. **UI:**
   - `/library` (not `/assets`, which is the immutable static-asset path): role choice, drag-and-drop or picker, client pre-checks, a browser-computed SHA-256, XHR progress and cancel, previews on a checkerboard (so transparency is visible) via signed URLs refreshed before expiry, a usage meter, filters and delete.
   - The experience page gains a tracking-image picker: upload or choose; the printed size is computed from the width and aspect ratio; change or remove.

**Consequences / pending:**
- **Remote verification:** create both R2 buckets (owner approval), apply migrations 0002 and 0003 to Neon development, redeploy `ar-creator-dev`, then verify uploads, bucket privacy and signed reads on the edge.
- **Not built yet:**
  - thumbnails and derivatives;
  - range requests (may matter for native viewers);
  - cleanup of expired or rejected slots;
  - presigned and multipart strategies;
  - rendered model previews.

## ADR-023 — Image-to-AR conversion pipeline: Workflow + GLB in the Worker + USDZ in a Cloudflare Container (Phase 2 Milestone 1)

**Date:** 2026-11-22  
**Status:** Accepted by the product owner (host choice: Cloudflare Containers). Verified locally; **the Container class and the deployed Workflow are not verified on Cloudflare** (local Containers are unsupported on Windows), and nothing is deployed.  
**Context:** Phase 2 turns a display image into `image-object.glb` + `image-object.usdz`. The GLB writer is TypeScript (`packages/image-to-ar`); the USDZ writer needs OpenUSD (Python `usd-core`, `services/usd-processor`), which cannot run in a Worker. Conversions must be durable, idempotent and retried, and the alpha mode must be decided once for both files (ADR-009).  
**Decision:**
1. **Host.** USDZ is built by the existing converter image (Dockerfile `runtime` stage, default target; `test` stage adds pytest) running as a **Cloudflare Container** (`@cloudflare/containers` 0.3.7, class `UsdConverterContainer`, `instance_type: basic` = 1 GiB like the local sandbox, `max_instances: 3`, `sleepAfter: 3m`, **`enableInternet = false`**). It is reached through its Durable Object stub; requests are spread with `getRandom(…, 3)`. Containers need Workers Paid.
2. **Narrow converter protocol.** `python -m usd_processor serve` (stdlib HTTP, one request at a time): `POST /v1/image-plane?width_m&alpha_mode&alpha_cutoff&double_sided&pivot&orientation`, the image bytes as the body (Content-Length required, ≤ 32 MiB, optional `X-Source-SHA256` checked), answer `u32be(len) + JSON + usdz`. Unknown/duplicate parameters → 400, conversion or validation failure → 422 (JSON, no host paths). The **Worker streams the source in and stores the result**, so the container holds no credentials, no storage access and no network. Anchoring is not offered here (per-experience compilation is Phase 5).
3. **Orchestration.** One **Cloudflare Workflow** instance per attempt (`IMAGE_TO_AR`, instance id `{jobId}-a{attempt}`; a duplicate create is a no-op). Steps: `start` (mark running, re-check the source is the owner's validated display image), `glb`, `usdz`, `finish`; on final failure a `fail` step records the code. User-caused failures throw `NonRetryableError`; converter outages retry (4×, exponential from 10 s) to absorb cold starts. The steps are plain functions (`apps/api/src/conversions/pipeline.ts`); the Node test runner (`inlineRunner`) executes the same functions in-process.
4. **Alpha decided once, in the Worker, without decoding to memory.** `scanPngAlpha` (new, `packages/image-to-ar`) inflates IDAT with `DecompressionStream` and unfilters **one scanline at a time** (all colour types, bit depths 1–16, palette/tRNS, Adam7), so an 8192 × 8192 PNG fits in 128 MB. The inflated size must equal what the header implies (bomb/truncation guard). Results equal a full decode on every fixture. `resolveAlphaMode` then picks the mode, which is passed to both writers; the source bytes are re-verified against the stored SHA-256 before each use. JPEG with EXIF orientation ≠ 1 is refused (`unsupported_image`) until normalisation exists (ADR-009).
5. **Idempotency and reuse.** Settings are parsed (defaults applied), serialised canonically and hashed. Job key `i2a:{assetId}:{settingsHash}:{glbVersion}+{usdVersion}` (unique). Same settings again → the existing job (200), no new work; a failed job may be restarted up to `max_attempts` (3), reusing any output already finished. Derivative rows are unique per provenance (source, type, settings hash, converter version); keys are `users/{uid}/assets/{assetId}/derivatives/{sha256(settingsHash + converterVersion)}/display.{glb|usdz}`; a row is written `pending` before the object and `ready` (key, checksum, size) after, and a ready row's key and checksum are immutable (trigger from 0001). GLB and USDZ must agree on width, height and alpha mode, and the USDZ converter version must equal `USD_CONVERTER_VERSION` (a unit test reads the Python constant), or nothing is marked ready (`output_mismatch`).
6. **Limits and ownership.** Only the owner's validated PNG/JPEG display images (409 `not_convertible` otherwise; another user's → 404). At most 3 queued/running conversions per user (429). Generated outputs count toward the 1 GiB quota (usage and upload checks), and a conversion is refused up front if `2 × source size` would exceed it. Deleting a source is refused while it is converting (409 `conversion_running`) and otherwise removes every derivative object before the row.
7. **Reads.** `GET /api/derivatives/:id/content` uses the signed-URL scheme of ADR-022 with a **kind** in the signed message and path (`derivative-read/v1`), so a derivative signature can never open an original or vice versa. Types: `model/gltf-binary`, `model/vnd.usdz+zip`; `?download=1` switches to `attachment` with a sanitised `{name}-image-object.{ext}`.
8. **Local development.** `vite dev`/`preview` run the real local Workflow engine; `dev.enable_containers` is false and the Workflow reaches the same image run by Docker at `USD_CONVERTER_URL` (`npm run usd:serve`, loopback only, read-only root FS, 1 GiB). The URL is honoured only when `APP_ENV=development` and only for loopback hosts, so a deployed Worker cannot be redirected by configuration. The dev deploy guard requires the dev Workflow name and at most 3 container instances.
9. **Schema (0004).** `processing_jobs.input` (immutable job input) and `error_code` (required when failed), an owner/asset index; `asset_derivatives.size_bytes` (required when ready), SHA-256 format and owned-prefix checks.
10. **UI.** `/library/:assetId/ar-object` ("Make AR object" on display-image cards): preview on a transparency grid, light or dark background; real-world width in cm/in with the derived height; transparency Auto/Cutout (+ threshold)/Blend/Opaque; orientation; origin point; sides. Live status, clear failures, USDZ/GLB downloads, earlier versions. The page says plainly that AR rendering is not yet device-verified.

**Alternatives:** TypeScript USDZ writer in the Worker (rejected: binary `.usdc` reimplementation, replaces the validated converter); external conversion service (more infrastructure and credentials); `ctx.waitUntil` instead of Workflows (no durability or retries).  
**Consequences / pending:**
- **Remote (approval each):** apply 0004 to Neon development; redeploy `ar-creator-dev` (first Container deploy: pushes the image to Cloudflare's registry; needs Workers Paid on the account); run REMOTE-CONVERT. Until then the Container path, cold-start time and `basic` sizing are **unverified**.
- **Device:** Quick Look / Scene Viewer rendering of generated files is **NOT TESTED** (same open rows as the P0 alpha cases).
- **Not built:** 3D preview of the result, adding the object to an experience, WebP/EXIF normalisation and downscaled texture derivatives (ADR-009), cleanup of failed jobs' partial outputs beyond reuse, cutout/extruded shapes (hidden).

## ADR-024 — Image objects in experiences, 3D preview and soft-edge highlight (Phase 2 Milestone 7)

**Date:** 2026-11-22
**Status:** Accepted (verified locally; not yet deployed to the dev Worker)
**Decision:**
1. **What a scene references.** An `image-object` node's `derivativeId` is the id of the **GLB** derivative of a finished pair. A draft save accepts it only when the owner's GLB is `ready`, its source asset is validated, and the **USDZ partner** (same source and settings hash) is `ready` too — iOS needs the USDZ, Android/web the GLB. Another user's, a USDZ id, a missing or incomplete pair → 400 "This image object does not exist or is not ready." Nodes are placed at the anchor origin (identity transform) until the visual editor (Phase 3).
2. **Deletion protection extends to generated objects.** Deleting a source image is refused (409 `asset_in_use`, naming the experiences) while any revision has a node whose `derivativeId` is one of the image's derivatives.
3. **Listing.** `GET /api/image-objects`: the owner's succeeded conversions whose two outputs are ready, newest first (≤ 100), with signed GLB/USDZ links and a signed preview of the source.
4. **3D preview** (`ModelPreview`, three.js 0.186.1 — the version the P0 probe pins): renders the real GLB with its authored alpha mode and sides, a 10 cm grid, orbit/zoom; render-on-demand (no animation loop); every GPU resource freed on unmount; WebGL-unavailable and load-error states. **Lazy-loaded**: three.js is only in its own chunk, the main bundle is unchanged in kind (159 KB gzip). Labelled as a desktop preview — it does not show how AR Quick Look or Scene Viewer render the files.
5. **Soft-edge highlight.** Partly transparent pixels (0 < alpha < 255) are painted magenta over the 2D preview with the share reported. The image is drawn at ≤ 1024 px with **nearest-neighbour** sampling, so a hard cutout never shows false soft edges; the signed image is same-origin, so the canvas is readable under the existing CSP.

**Consequences:** Publishing/compilation (Phase 5) will read image objects through the GLB id and its USDZ partner. Transform editing, multiple instances of the same object per scene (the picker hides already-placed objects) and per-device rendering checks remain open.

## ADR-025 — Texture preparation: WebP, EXIF rotation and a 2048 px texture budget (Phase 2 Milestone 8)

**Date:** 2026-11-22
**Status:** Accepted (verified locally; not yet on the dev Worker). Resolves the pending part of ADR-009.
**Context:** ADR-009 embeds the uploaded bytes unmodified, which works only for upright PNG/JPEG within viewer texture budgets. WebP is neither core glTF nor allowed in USDZ; EXIF-rotated JPEGs would display sideways; very large images waste memory on phones.
**Decision:**
1. **Original bytes whenever possible.** A new first pipeline step decides what both files embed. PNG/JPEG that is upright (EXIF orientation 1) and at most **2048 px** on its longest edge is embedded unchanged, exactly as before (tests assert byte equality for every committed fixture).
2. **Otherwise one prepared texture, made once and shared.** The converter container (same image, new `POST /v1/texture?max_edge=2048`, Pillow 13.0.0) prepares it and the Worker stores it as an `image_object_texture` derivative (migration 0005), keyed by source × texture policy, so the GLB (Worker) and USDZ (Container) embed **byte-identical** bytes (asserted in tests) and different settings reuse it.
   - WebP → PNG when it has transparency or came from a lossless/opaque PNG-like source; opaque **lossy** sources (JPEG, lossy WebP) → JPEG quality 92, 4:4:4 chroma. Lossless WebP → PNG is pixel-exact.
   - EXIF orientation ≠ 1 → pixels rotated upright, orientation tag dropped.
   - Longest edge > 2048 → Lanczos downscale **in premultiplied alpha** (no dark fringes from transparent black pixels; Pillow already does this for RGBA, the explicit step keeps it independent of that), aspect ratio kept; the physical width does not change.
   - Fully opaque alpha channels are dropped; metadata is not copied; animated images and anything over 64 MP are refused; output is deterministic.
   - The Worker re-reads the prepared texture's header and refuses it if type, size or budget disagree with what the converter reported.
3. **Provenance.** The texture policy (`texture@0.1.0/max2048`) is part of the GLB and USDZ converter versions and of the job key (folded into a digest), so outputs made under different texture rules are never reused for each other. Jobs created by older code are refused by `startJob` instead of being finished with mislabelled outputs.
4. **Uploads.** Display images accept **still WebP** (header-only checks: VP8/VP8L/VP8X dimensions and alpha flag, RIFF size must equal the file size, animation refused). Tracking images stay PNG/JPEG (Quick Look reference images and the WebXR tracker load them directly).
5. **UI.** The page says when an image will be scaled down or converted, and the result explains what was done ("converted to PNG", "turned upright…", "scaled down from … to … px for phones").

**Why 2048:** a conservative common budget for mobile AR viewers; it is an engineering choice, **not yet confirmed on devices** — revisit with the device matrix.
**Consequences:** Pillow's decoders are new attack surface inside the network-less, credential-free container (SECURITY.md). Colour profiles are not converted (prepared textures drop ICC data; originals keep theirs) — pending. Tracking-image WebP remains unsupported.

## ADR-026 — "View in AR" for a single image object (Phase 2 device testing)

**Date:** 2026-11-22
**Status:** Accepted (verified in browser tests; device behaviour NOT TESTED).
**Context:** The Phase 2 gate needs product-generated files opened in the native viewers on phones. The "Make AR object" page only had downloads: workable on iPhone (Downloads → Quick Look), but Android has no reliable way to hand a downloaded GLB to Scene Viewer.
**Decision:**
1. The result shows **View in AR**, built only by `packages/platform-launch` (`viewInAr`), following the central routing for a floor placement: iOS → AR Quick Look `<a rel="ar">` on the signed USDZ URL (first child an `<img>`, as Quick Look requires); Android → Scene Viewer intent, `placement: 'floor'`, `mode=ar_preferred`, Google app package, `file` = signed GLB URL, title = file name. Never WebXR image tracking (that needs an experience with a tracking image).
2. Shown only when it can work: not on desktop (the page says to open it on a phone), not in iOS browsers without Quick Look (`relList.supports('ar')`), and not when the file or fallback URL is not HTTPS (local dev).
3. Scene Viewer's `browser_fallback_url` is the same page with `?ar=unavailable`, which explains that the Google app and ARCore are needed.
4. Signed URLs are cookieless and live 15 minutes; the page refreshes them every 7.5 minutes and when the tab becomes visible again (a phone waking up).
5. The page now shows the **newest version** when nothing was converted in this visit, so a file converted on a computer can be opened on the phone.
**Consequences:** Placement is fixed to floor for this preview; wall/image placement belongs to experiences (P4/P5). Content scaling stays at the viewers' defaults (testers must not pinch before measuring). Device behaviour is unverified until the Phase 2 checklist (`tests/device/phase-2-checklist.md`) is run.

## ADR-027 — Scene editor workspace and viewport (Phase 3 Milestone 9)

**Date:** 2026-11-22
**Status:** Accepted (browser tests; desktop only).
**Context:** Phase 3 needs a visual editor over the canonical scene (DATA_MODEL.md) without letting the editor become a second source of truth, and edits must never be lost to autosave races.
**Decision:**
1. **Workspace:** object tree (left), three.js viewport (centre, lazy chunk), inspector (right); viewport first, then tree and inspector stacked below 1100 px / 640 px. Lives on the experience page under Placement; edits go through the existing debounced autosave with optimistic concurrency (ADR-021).
2. **Canonical axes in the viewport (ADR-005):** floor = 10 cm grid on XZ; wall = grey XY plane at z = 0 with a grid, content in front (+Z); image = the tracking image itself, textured, lying in XZ at its printed size (height from the pixel aspect), top edge toward −Z; RGB axes at the anchor origin. No axis conversions in the editor — the scene's numbers are drawn as they are.
3. **Content:** image-object nodes are drawn from their real GLB (cached by derivative id, since signed URLs change), with the node transform. Other kinds are listed but marked "not shown in the 3D view yet" until M11. Hidden nodes and their descendants are not drawn. The inspector shows the size measured from the loaded file × scale ("Size in the scene").
4. **Selection:** tree or click in the view; a drag (> 4 px) orbits and never selects or moves anything. The camera frames content plus the tracking image, not the helper grids.
5. **Edits are functions of the latest scene** (`SceneEdit`): anything asynchronous (uploads, dialogs) edits the latest scene instead of a copy captured earlier. This fixed a lost update found while testing: a tracking image upload finishing after an object was added saved the old scene and removed the object (regression test fails on the old code).
6. Removing a node never removes its children (they move to its parent). The same image object may be placed more than once.
7. The viewport flags objects whose picture failed to load ("shape only") instead of drawing them grey.
**Consequences:** Transforms are read-only until M10. The preview is labelled "3D preview — not AR"; device rendering is unchanged and unverified.

## ADR-028 — Transforms, gizmos and undo/redo in the scene editor (Phase 3 Milestone 10)

**Date:** 2026-11-22
**Status:** Accepted (browser tests read the saved scene back from the API; desktop only).
**Decision:**
1. **Units:** the inspector shows position in centimetres, rotation in degrees (intrinsic X→Y→Z, three.js 'XYZ') and one uniform scale in %; the scene stores meters, a unit quaternion (canonical sign w ≥ 0) and `[s, s, s]`. Values are rounded (µm, 1e-9) so equal-looking transforms are equal. Rotation is recomputed only when a rotation field changed, so a quaternion is never disturbed by a round trip through degrees. The math lives in `apps/web/src/editor/transforms.ts` without three.js (unit-tested against known rotations).
2. **Typed values** apply on Enter or when focus leaves the transform form (moving between its fields does not apply, so a field is never replaced mid-typing). Limits: ±100 m, 1 %–10 000 %; errors are explained and nothing is saved.
3. **Gizmos** (three.js TransformControls) appear only with an explicit tool (Move/Rotate/Scale; Q/W/E/R) on a visible, unlocked selection; the camera does not orbit during a gizmo drag; pressing a handle never changes the selection; a drag is committed once at the end (one undo step). Scale stays uniform whichever handle is dragged (pictures are never stretched). Snapping (default on): 1 cm, 15°, 5 %.
4. **Hierarchy:** the viewport now builds the node hierarchy (children follow parents); gizmo and align edits are in the node's parent space.
5. **Commands:** lock (blocks transforms, gizmo, align and remove), duplicate (new id, " copy", +10 cm X, unlocked; children are not copied), remove; align by the real drawn bounds — *Put on floor/image* (lowest point to y = 0), *Flush to wall* (back to z = 0), *Fit to image* (uniform scale to the tracking image's width, centred, resting on it).
6. **Undo/redo** covers node edits of this editing session (limit 100; buttons, Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl+Y). Placement, tracking image and details are not part of it, so undo never reverts them; a placement change clears the history. Each undo/redo is autosaved like any edit. Shortcuts are ignored while typing in a field or with a dialog open.
**Consequences:** History does not survive a reload (by design for now). Device behaviour unchanged and unverified.

## ADR-029 — Models, text, panels, shapes and budgets in the editor (Phase 3 Milestone 11)

**Date:** 2026-11-22
**Status:** Accepted (browser tests; desktop only; AR output of these kinds arrives with the P4 compilers).
**Decision:**
1. **Canonical geometry** (`packages/schema/src/content.ts`), which the P4 compilers must reproduce: every built-in is centred on its node origin, in the node's XY plane facing +Z. Shapes are 1 m unit shapes (box 1³, sphere Ø 1, cylinder Ø 1 × 1 along +Y, plane 1 × 1) sized by the node scale (new shapes 20 %). Text: `style.sizeMeters` is one line box; lines centred. Panels: a white card 30 cm wide, height from the content.
2. **Schema:** `primitive.color` (#rrggbb) added as an **optional** field (default #9aa5b1); existing scenes stay valid; `schemaVersion` stays 1 (additive). All colours share one #rrggbb rule.
3. **Text and panels are drawn onto a canvas texture**, the same approach the compilers will use to bake them for Quick Look and Scene Viewer (capabilities `text_panel` = `compiled_visual`); device fonts may differ slightly.
4. **Models** are uploaded GLBs (role `model`) picked from the library or uploaded inside the editor; the server already validates ownership/role and blocks deleting a model in use. Animations are listed, not played.
5. **New content starts on the surface** (centred kinds lifted by half their height, or 2 mm in front of a wall).
6. **Budgets** follow Google's Scene Viewer file requirements (read 2026-11-22): 100,000 triangles, 10 materials, 2048 px textures and 10 MB recommended; 15 MB is an error. Shown per object (triangles, materials, textures, largest texture) and for the scene (visible objects; triangles/materials add up per copy, files count once). Quick Look publishes no hard numbers; device tests decide.
7. **"In AR"** in the inspector shows the capability registry's plan for the object's kind per viewer, labelled as planned and not device-tested. A `shape` feature was added to the registry (iOS/Scene Viewer `verify`, Android image `native`).
**Consequences:** Text, panels, shapes and models do not appear in AR until the compilers exist (P4); the editor says so. Model files over 15 MB can be placed but are flagged.

## ADR-030 — Actions, tap actions, hotspots and the main button in the editor (Phase 4 Milestone 12)

**Date:** 2026-11-22
**Status:** Accepted (browser tests read the saved scene back; where each action appears per AR viewer is M13).
**Decision:**
1. **Action kinds** are the schema's: web link (https only), email, phone, show/hide an object, play a model animation. Validation is the scene schema itself, with plain-language messages. Button text is optional (defaults: "Visit website", "Send email", "Call").
2. **Uses:** any object can have one tap action ("On tap"); a **hotspot** (4 cm marker, drawn in the editor) exists only to run an action, so it always has one; **one main button** per experience, and only a web link can be it (Quick Look banner and Scene Viewer `link` carry an https URL). Editing the main button into another kind clears that role, with a notice.
3. **No dangling references, nothing removed silently:** deleting an action clears its tap uses and main-button role and lists them; an action used by a hotspot cannot be deleted until the hotspot changes; removing an object also removes the actions that show/hide or animate it, and hotspots left without an action, and says exactly what went. The result is always a valid draft (unit-tested against the schema).
4. **Undo covers content:** nodes, actions and the main button are edited and undone as one unit (so one undo restores an object together with the actions removed with it). Placement, tracking image and details remain outside undo.
5. **Animation clips** are read from the loaded model file (unnamed clips as "#index"); the play-animation action is offered only when the scene has a model.
**Consequences:** Whether a tap or a link actually works depends on the viewer (Quick Look and Scene Viewer have no taps): M13 computes and shows that plan, and nothing is dropped from the experience page.

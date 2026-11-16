# CHANGELOG.md

This changelog records actual specification and implementation changes. Do not claim features are shipped because they are listed in a prompt.

## 2026-11-15 — Phase 1 Milestone 4: experience management (local)

### Added
- Experiences API: list, create (with draft revision 1), get, update metadata, delete, `PUT /:id/draft` (scene configuration API with optimistic concurrency), `POST /:id/validate` (publish readiness). Ownership enforced in SQL; other users' experiences return 404.
- `DraftExperienceScene`, `planPlacementChange`, `publishReadiness`, default scenes per placement mode (`packages/schema`); experience contracts (`packages/contracts`).
- Migration `0002_draft_version`.
- UI: dashboard (search, empty/loading/error states), new-experience page with an accessible placement selector (per-platform runtimes, experimental badge), experience page with autosave, conflict recovery, placement-change review dialog, image printed width, readiness panel, details editing, delete confirmation. Dashboard link in the header; sign-in now lands on the dashboard.
- ADR-021.

### Changed
- The CSRF guard requires a JSON body type only for POST/PUT/PATCH; DELETE is protected by the Origin check.
- Phone header layout; placement-change copy mentions the tracking image only when one is set.

### Status
- Verified locally. Neon development needs migration 0002 (approval) and `ar-creator-dev` a redeploy before remote verification.

## 2026-11-15 — Neon development setup and remote authentication verification

### Added
- `db:remote create-roles` (SQL-created restricted roles; hidden password prompts; attribute verification), `--host` mode (password-only prompts, URL encoding), `remote-auth-test` (temporary seeded user, remote Playwright suite, guaranteed cleanup).
- Isolated Worker `ar-creator-dev` (`env.dev`, dev Hyperdrive only, production-strict, sign-up off) and `npm run deploy:dev` with binding and secret-leak guards and `--dry-run`.
- Remote suite `tests/remote` (9 checks). ADR-020.

### Fixed
- TLS check reads the client-side socket (Neon's proxy makes `pg_stat_ssl` report false); `sslmode=verify-full` made explicit.
- Environment marker accepts a database comment (Neon denies `ALTER DATABASE … SET` custom parameters to `neondb_owner`).
- Deploy output no longer carries the Vite plugin's copy of `.dev.vars`.

### Verified
- Neon development: migrations applied as `ar_migrator`, runtime suite 8/8 as `ar_app`. Cloudflare edge: REMOTE-AUTH-01 9/9. Production untouched.

## 2026-11-14 — Phase 1 Milestone 3: authentication (local)

### Added
- Better Auth 1.7.16 in the Hono API: email + password with required email verification, password reset, sign-out and revoke-all, 7-day DB-backed sessions (no cookie cache), database rate limits per client IP, allowlisted endpoints, fail-closed configuration; `/api/auth-config`, `/api/session`, protected `/api/me`, `requireSession`.
- Email: Resend mailer (env/secret-configured) and a localhost-only development mailbox; escaped templates with own-origin links.
- UI: sign-in, sign-up (closed state), check-inbox with resend, email confirmed, forgot/reset password, account page; `RequireAuth` protected routes; session-aware header; validation, loading and error states.
- Local secrets: `npm run dev:env` writes the gitignored `apps/web/.dev.vars`; fail-closed production vars in `wrangler.jsonc` (sign-up off).
- Neon: role model SQL, guarded `npm run db:remote` (status/migrate/verify), runbook `infra/db/NEON.md`, remote runtime-role suite; local rehearsal.
- Tests: 30 auth integration, 10 role-model, unit and e2e auth flows. ADR-018, ADR-019.

### Security
- Fixed a password-reset token leak via foreign `redirectTo`, an open redirect on verification, and login CSRF (Better Auth 1.7.16 behaviours); session tokens removed from JSON responses; `@better-auth/core` version skew pinned.

### Status
- Verified locally only. Neon, Hyperdrive (as `ar_app`), Cloudflare and Resend not verified.

## 2026-11-14 — Phase 1 Milestone 2: database

### Added
- `packages/db`: Drizzle schema (Better Auth tables + experiences, experience revisions, assets, asset derivatives, processing jobs, generated outputs), version-controlled migrations including immutability triggers, per-request connections via Hyperdrive, error classification and credential redaction, database health check with migration status.
- Local PostgreSQL 17 via Docker with per-developer random credentials in the gitignored `.env`; `db:*` and `test:db` scripts.
- `/api/health` database check (HTTP 503 `degraded` on failure or pending migrations); home page shows database status.
- Hyperdrive binding (`HYPERDRIVE`, caching disabled) in `apps/web/wrangler.jsonc`; ADR-017.
- Tests: 28 DB integration tests, API health/failure unit tests, e2e for dev/preview/database-down, and a build-output secret scan.

### Security
- better-auth tooling pinned to 1.7.16 (fixes the 2026-11-03 advisories in ≤1.7.15); drizzle-kit's vulnerable transitive esbuild overridden.

### Status
- Verified locally only. Production migrations not applied (awaiting owner approval). Nothing deployed.

## 2026-11-14 — Phase 1 Milestone 1: application skeleton

### Added
- `apps/web`: Vite + React SPA (React Router, TanStack Query, CSS Modules with design tokens), accessible layout, home page with live API status, not-found and error routes; deployable Worker config (`wrangler.jsonc`) bundling `apps/api` via `@cloudflare/vite-plugin`.
- `apps/api`: Hono API under `/api` with `/api/health`, request IDs, security headers, `no-store`, and a JSON error contract that never leaks internals.
- `packages/contracts`: shared Zod API contracts.
- Playwright `app-dev` / `app-preview` projects running in workerd; root `dev`, `build`, `preview` scripts.
- ADR-015 (owner service choices), ADR-016 (skeleton conventions).

### Security
- Hono pinned to 4.13.16 to avoid five advisories in ≤4.13.15. Client source maps are no longer emitted.

### Status
- Verified locally only; not deployed.

## 2026-11-14 — Phase 1 planning and authentication decision

### Added
- `spikes/auth-workers`: Better Auth + Hono + Drizzle + pg/Hyperdrive verified in local workerd (16/16 checks) plus a password-hash CPU benchmark.
- ADR-013 (Better Auth; per-request client and auth instance; Workers Paid plan required; Hyperdrive caching disabled for auth reads) and ADR-014 (single same-origin Worker, proposed).
- Phase 1 slice plan, open owner decisions and risks in `ROADMAP.md`; P1 tasks expanded.

## 2026-11-14 — First device result (AND-IMG-01) and probe 0.2.0

### Verified on device (PARTIAL)
- Android / Chrome 157: native WebXR `image-tracking` granted, target rated trackable, pose acquired in 6.9 s, DOM overlay shown and tappable. Size, alignment, axes, re-acquire and device identity are not yet verified.

### Fixed
- Probe treated the UA-reported image width as a measurement; Chrome echoes the registered width. It is now flagged and never used as size evidence (ADR-012).
- Probe reports could not identify the device under Chromium's reduced UA; they now use UA Client Hints.
- Probe reports now include tester observations, raw per-frame state counts, session duration and end reason.

## 2026-11-14 — Android WebXR image-tracking probe

### Added
- `packages/webxr-image`: native WebXR image-tracking capability adapter (Chrome `image-tracking` shape only; `marker-tracking` reported, never guessed), preflight with timeout, tracking state machine, `ImageAnchorTracker`, pose composition, user-facing error mapping.
- `apps/p0-webxr-probe`: Vite + three.js AND-IMG-01 harness at `out/p0/webxr/`, with DOM-overlay status and CTA, axis helper for the image-frame hypothesis, and a privacy-safe JSON report.
- Playwright (local Edge channel) e2e tests; `scripts/serve-p0.ts` static server that applies `_headers`.
- ADR-010, ADR-011.

### Fixed
- USDZ outputs were not byte-reproducible across runs (ZIP timestamps); now normalized.
- Device lab CSP now allows `blob:` in `img-src`/`connect-src`, which GLTFLoader needs for embedded GLB textures; added an inline empty favicon (avoids a 404 on every page).
- Probe preflight no longer hangs if `isSessionSupported` never resolves, and no longer waits on asset preload.

### Status
- Desktop-tested only. **No AR device testing performed.**

## 2026-11-14 — P0 runtime-proof kit (first code)

### Added
- npm workspace with strict TypeScript 5.9, Vitest 4, `npm run check` / `check:all`.
- `packages/schema`: Zod v1 canonical scene (placement union, transforms, nodes, actions with cycle/reference checks), outbound URL policy (https/mailto/tel only), Image-to-AR settings, explicit asset roles.
- `packages/platform-launch`: the single audited Scene Viewer intent builder (`ar_preferred`, Google app, fallback URL, `link`, wall `enable_vertical_placement=true`), Quick Look href/banner builder and CTA tap handler, central `resolveRuntime` mapping.
- `packages/capabilities`: typed capability registry (6 runtimes × 12 features) and compatibility report.
- `packages/image-to-ar`: header-only image inspection with size limits, alpha analysis and Auto policy, flat-quad geometry, deterministic GLB writer embedding original image bytes.
- `services/usd-processor`: sandboxed Docker OpenUSD service producing matching USDZ (UsdPreviewSurface, alpha→opacity, MASK threshold) with Quick Look image/floor/wall anchoring and a structural validator.
- Golden fixtures (9 images, hash-locked) and a shared GLB/USD geometry contract.
- `scripts/build-p0.ts` P0 device-lab generator and `infra/p0-lab/wrangler.jsonc` (not deployed).
- ADR-005 … ADR-009; spec review findings and risk register in `ROADMAP.md`.

### Status
- Structurally validated only. **No device testing performed.**

## 2026-11-14 — Specification pack v3.0

### Changed
- Android non-image placement routed to native **Google Scene Viewer**, not WebXR.
- Android wall placement explicitly uses Scene Viewer `enable_vertical_placement=true` where supported.
- Android image-anchor experiences retain native experimental WebXR image tracking.
- Unified editor/publishing specification now composes a single GLB for native Scene Viewer.

### Added
- Image-to-AR conversion from PNG/JPG/WebP to **both GLB and USDZ**.
- Alpha-channel preservation requirements and tests for transparent or partly transparent PNG.
- Distinction between tracking references and visible image objects.
- Dedicated agent docs, design, architecture, platform routing, capabilities, data schema, security, test matrix, decision log and task tracking.

### Status
- Documentation prepared. No application implementation or native-device verification was performed in this pack.

# PROGRESS.md — Actual Implementation State

**Updated:** 2026-11-22  
**State:** P0 runtime-proof kit (incl. Android WebXR image probe) implemented and **structurally validated / desktop-tested**. **First device result: AND-IMG-01 PARTIAL** (native WebXR image tracking + DOM overlay worked on one Android/Chrome 157 device; visual/geometry checks outstanding). All other device rows NOT TESTED. **Phase 1 Milestones 1–5 done locally and verified on the isolated dev environment** (`ar-creator-dev` Worker → Hyperdrive → Neon development, R2 `ar-creator-assets-dev`): REMOTE-AUTH-01 9/9, REMOTE-CONTENT-01 8/8 (2026-11-22). Production not deployed or migrated.  
**Current phase:** Phase 1 complete on dev. Phase 1 gate ("a creator can securely create a draft and upload/retrieve a checked asset") **met on the edge with real R2**. Next: Phase 2 (Image-to-AR), awaiting the owner's go. P0 device rows still open (AND-IMG-01 re-run, AND-IMG-02, iOS, Scene Viewer).

## Implemented (automated evidence)

| Area | Location | Evidence |
|---|---|---|
| npm workspace, TS 5.9 strict, Vitest | `package.json`, `tsconfig.json`, `vitest.config.ts` | `npm run check` |
| Canonical schema v1 (placement union, nodes, actions, URL policy, Image-to-AR settings) | `packages/schema` | 10 tests |
| Audited launch utilities: Scene Viewer intent, Quick Look href + CTA message, central runtime router | `packages/platform-launch` | 14 tests incl. delimiter-injection, blob:/http: refusal |
| Capability registry (6 runtimes × 12 features) | `packages/capabilities` | 5 tests |
| Image-to-AR GLB generator (flat quad, OPAQUE/MASK/BLEND, original bytes embedded) | `packages/image-to-ar` | 41 tests; every fixture passes Khronos glTF-Validator with 0 errors/0 warnings |
| Image-to-AR USDZ generator + Quick Look anchoring (image/floor/wall) + structural validator | `services/usd-processor` (Docker) | 54 pytest tests in sandbox |
| Deterministic golden fixtures + shared geometry contract | `tests/fixtures`, `scripts/generate-*.ts` | hash-locked manifest; byte-identical regeneration |
| P0 device kit (7 GLB/USDZ pairs + device-lab page) | `scripts/build-p0.ts` → `out/p0/` | built locally; **not deployed**; USDZ byte-reproducible across rebuilds (ADR-011) |
| Android WebXR image runtime logic: adapter, preflight (timeout), tracker state machine, pose composition | `packages/webxr-image` | 16 tests |
| Android WebXR image-tracking probe (AND-IMG-01 harness, DOM overlay, JSON report) | `apps/p0-webxr-probe` → `out/p0/webxr/` | Playwright on desktop Edge: unsupported path, no console/CSP errors. **Never run on an AR device** |

## Commands actually run (2026-11-14, Windows 11, Node 24.19.0, Docker 29.8.0)

| Command | Result |
|---|---|
| `npm run typecheck` | pass (0 errors) |
| `npm test` | 4 files, **70/70 passed** |
| `npm run usd:build` | image `ar-creator/usd-processor:dev` (453 MB) |
| `npm run usd:test` | **54/54 passed** (sandbox: no network, read-only FS, 1 GB, 2 CPU) |
| `npm run fixtures` ×2 | byte-identical output |
| `P0_BASE_URL=https://p0-lab.example.workers.dev npm run p0:build` | 7 cases, 0 USD validation errors/warnings, GLB/USDZ heights match; probe built to `out/p0/webxr/` |
| *(probe session)* `npm run check:all` | Vitest 5 files **86/86**; pytest **55/55** |
| *(probe session)* `npm run test:e2e` (Playwright 1.64.1, local Edge) | **2/2 passed** |
| *(probe session)* `p0:build` twice, 3 s apart | identical USDZ hashes |

Not available yet: lint (ESLint/Prettier not configured), DB migrations, `apps/web` build.

## Not yet implemented or verified

- [ ] Any physical-device result (all TESTING.md matrix rows **NOT TESTED**).
- [ ] Vite/React app, Hono API, PostgreSQL/Drizzle/Hyperdrive, R2, auth, Workflows.
- [ ] Cloudflare Containers deployment of the USD processor.
- [ ] WebP/EXIF normalization; texture size limits.

## Known blockers

1. **Device tests** need (a) the P0 lab on public HTTPS (owner's Cloudflare account) and (b) an iPhone/iPad and an ARCore Android phone.
2. **Auth provider** is unspecified in the specs — needed before P1 ownership work.
3. Apple `usdchecker` needs macOS (ADR-008).

## Session handoff — 2026-11-14 / Claude Code

- Goal: spec review, toolchain, P0 proof-of-concept slice.
- Files changed: see `CHANGELOG.md` 2026-11-14 "P0 runtime-proof kit".
- Commands/tests actually run: table above.
- Device test evidence: none.
- Known blockers: above.
- ADRs added: ADR-005 … ADR-009.
- Tasks changed: P0/P1/P2/P4 items in `TASKS.md`.
- Next smallest testable step: deploy `out/p0` (`npx wrangler@4 deploy -c infra/p0-lab/wrangler.jsonc`), rebuild with the real `P0_BASE_URL`, redeploy, and run IOS-FLR-01 / AND-FLR-01 on devices.

## Session handoff — 2026-11-14 (2) / Claude Code

- Goal: Android WebXR image-tracking probe.
- Files: `packages/webxr-image/*`, `apps/p0-webxr-probe/*`, `scripts/serve-p0.ts`, `playwright.config.ts`, `tests/e2e/p0-lab.spec.ts`, `services/usd-processor/usd_processor/reproducible.py`, `scripts/build-p0.ts` (probe link, CSP `blob:` for GLTF textures, favicon).
- Found and fixed: USDZ hashes not reproducible (ZIP timestamps, ADR-011); `isSessionSupported` can hang (preflight timeout); preflight UI was blocked on asset preload.
- Device evidence: none. AND-IMG-01 needs an ARCore phone with Chrome "WebXR Incubations" enabled; quick local route: `npm run p0:build && npm run p0:webxr:dev`, then `adb reverse tcp:5173 tcp:5173` and open `http://localhost:5173` on the phone.
- ADRs: ADR-010, ADR-011.
- Next smallest testable step: run AND-IMG-01 (flag on) and AND-IMG-02 (flag off) and paste the probe's JSON report into `TESTING.md`.

## Session handoff — 2026-11-14 (3) / Claude Code

- Goal: review the AND-IMG-01 device report, fix probe defects, commit Phase 0, plan Phase 1.
- Device evidence: AND-IMG-01 PARTIAL (see `TESTING.md` "Device results").
- Fixed (probe 0.2.0, ADR-012): UA width echo flagged; device identity via UA Client Hints; tester-observation fields; raw frame counts; duration and end reason.
- Commands: `npm run check:all` → Vitest 91/91, pytest 55/55; `npm run test:e2e` → 2/2; `p0:build` → `img-overlay.glb` SHA unchanged (`2b1167ae…`), so the device result applies to the current asset.
- Next device step: re-run AND-IMG-01 with probe 0.2.0, filling in every observation; run AND-IMG-02 (flag off).
- Committed Phase 0 as `ddf4aa9` on `webxr-feature` (not pushed).
- Phase 1 (uncommitted): Better Auth evaluated and accepted (ADR-013) after a local-workerd spike (`spikes/auth-workers`, 16/16 checks); single same-origin Worker proposed (ADR-014); Phase 1 slice plan in `ROADMAP.md`; P1 tasks expanded.
- Phase 1 blockers (owner decisions): Postgres provider/region, email provider, Workers Paid plan, upload path.
- Next smallest testable step (P1-1): scaffold `apps/web` + `apps/api` as one Worker with `@cloudflare/vite-plugin` and prove `/api/health` + SPA fallback in `vite dev` and in a production build.

## Session handoff — 2026-11-14 (4) / Claude Code — Phase 1 Milestone 1

- Branch: `feature/p1-m1-skeleton` (from `phase-0` @ `60ec95e`; Phase 0 commits untouched).
- Goal: application skeleton — one Worker serving the Vite/React SPA and the Hono API from the same origin.
- Built: `apps/web` (React 19.3.1, React Router 8.5.1, TanStack Query 5.105.0, CSS Modules with DESIGN.md tokens, layout with skip link, home page with live API status, not-found and error routes, typed API client validated by contracts), `apps/api` (Hono 4.13.16: request IDs, security headers, no-store, `/api/health`, JSON error contract), `packages/contracts`, `apps/web/wrangler.jsonc` (SPA fallback + `run_worker_first: ["/api/*"]`, nodejs_compat, observability), `public/_headers`.
- Verified locally: see `TESTING.md` P1 M1 rows (typecheck, Vitest 96/96, pytest 55/55, Playwright 13/13 in workerd for dev and production builds, `npm audit` 0).
- Not verified: anything on Cloudflare's edge (no deploy was performed: needs the owner's account); visual QA beyond Edge desktop/phone-width screenshots; no ESLint/Prettier yet.
- ADRs: ADR-015 (owner decisions), ADR-016 (M1 conventions; ADR-014 verified locally).
- Next smallest testable step: Milestone 2 — `packages/db` with Drizzle schema + migrations against Dockerised Postgres, Hyperdrive binding with `localConnectionString` from `.dev.vars`/env, a per-request connection helper, and `/api/health` gaining a `database` check.

## Session handoff — 2026-11-14 (5) / Claude Code — Phase 1 Milestone 2 (database)

- Branch: `feature/p1-m2-database` (from `feature/p1-m1-skeleton` @ `a42eb74`).
- Built: `packages/db` (Drizzle schema = Better Auth tables + 6 app tables, migrations `0000_initial_schema` + `0001_immutability_triggers`, `connectDb` per request, error classification + redaction, `checkDatabase` with migration status), local Postgres (`infra/db/docker-compose.yml`, `npm run db:env|db:up|db:down|db:migrate|db:generate|db:auth-schema|test:db`), API DB middleware (lazy, closed via `waitUntil`), `/api/health` database check (503 when degraded), Hyperdrive binding `8de2df3d333b4a1b9b07c18fbdd49d18` in `apps/web/wrangler.jsonc` (ID only), home page database status.
- Verified locally: see `TESTING.md` P1 M2 rows (Vitest 104, DB integration 28, USD 55, Playwright 22, connection-leak check, `npm audit` 0).
- **Not verified / not done:** no deploy; Neon and the real Hyperdrive config were never contacted; **production migrations not applied** (awaiting approval); Hyperdrive caching-disabled is per the owner's statement, not independently checked.
- ADR: ADR-017.
- Next: Milestone 3 (Better Auth in `apps/api`, sign-up/in/out, protected routes, Resend verification + recovery, public sign-up gated).

### Production migration procedure (run ONLY after owner approval)

1. In Neon, copy the **direct** (non-pooled) connection string for the production branch, ideally for a dedicated migration-owner role.
2. From a trusted machine, without saving it to any file: `DATABASE_URL='<neon direct url>?sslmode=require' npm run db:migrate`
   (an explicitly set `DATABASE_URL` takes precedence over the local `.env`).
3. Deploy, then confirm `GET /api/health` reports `checks.database.migrations: "current"`.
4. Record the date, migration tags (`0000_initial_schema`, `0001_immutability_triggers`) and operator in `TESTING.md`.

## Session handoff — 2026-11-14 (6) / Claude Code — Phase 1 Milestone 3 (authentication)

- Branch: `feature/p1-m3-auth` (from `acf89f5`). Milestones 1–2 untouched except the additive auth wiring in `apps/api/src/app.ts` and the session-aware header.
- **Part A (Neon):** `wrangler hyperdrive get` confirmed caching disabled; origin role is `neondb_owner` on `ep-plain-unit-bcruyo1j` (branch unknown). Built the role model, guarded `db:remote` tool and runbook (`infra/db/NEON.md`, ADR-018); rehearsed locally. **Nothing was run against Neon. Hyperdrive was not modified.**
- **Part B (auth, local):** Better Auth 1.7.16 integration, UI pages, dev mailbox, Resend mailer, fail-closed config, rate limits; three security findings fixed (ADR-019).
- **Tests:** typecheck clean; Vitest 124; DB 38; integration 30; USD 55; Playwright 36; `npm audit` 0.
- **Not verified:** Neon (migrations, roles, runtime suite), Hyperdrive as `ar_app`, anything on Cloudflare (no deploy or preview upload), Resend delivery, edge-set CF-Connecting-IP, Secure cookies over real HTTPS, sign-in CPU on Paid.
- **Owner actions needed:** NEON.md steps 1–3; approval for `db:remote migrate --env development`; Hyperdrive origin → `ar_app` (dashboard); authorization for a preview upload (`wrangler versions upload`, not a production deploy) to run the remote checks; Resend key + verified domain.
- **Local setup for new machines:** `npm run db:up` (creates `.env` and `apps/web/.dev.vars` with random local secrets) → `npm run db:migrate` → `npm run dev`. Emails appear at `http://localhost:5173/api/dev/mailbox`.
- Next: Milestone 4 (dashboard, experiences, drafts, placement selector, scene configuration API). Not started.

## Remote approvals log

| Date | Approved by | Action | Target | Status |
|---|---|---|---|---|
| 2026-11-15 | product owner ("approved: migrate development") | `db:remote migrate --env development`: migrations `0000_initial_schema`, `0001_immutability_triggers` + `02-app-grants.sql` as `ar_migrator` | Neon development branch, endpoint `ep-weathered-resonance-bce5rdkp`, db `neondb` (marker `ar.environment=development`) | **done 2026-11-15**: 2/2 applied, runtime grants applied, TLSv1.3 verified, confirmation typed |
| 2026-11-15 | product owner ("Approved") | `npm run deploy:dev -- --subdomain quiet-dawn-af59`: create isolated Worker `ar-creator-dev` (dev Hyperdrive only, sign-up off) | Cloudflare account `a91b768f…`, `https://ar-creator-dev.quiet-dawn-af59.workers.dev` | approved |
| 2026-11-22 | product owner (performed by the owner) | Created R2 buckets `ar-creator-assets-dev` and `ar-creator-assets`; applied migrations `0002_draft_version` + `0003_asset_uploads` to Neon development; redeployed `ar-creator-dev` (version `aec8691a…`, build `a162f66`) | Neon development endpoint `ep-dark-butterfly-bctzb64e`; Cloudflare account `a91b768f…` | **done 2026-11-22**: verified by health (migrations current), `db:remote` (4/4), REMOTE-CONTENT-01 |

## Session handoff — 2026-11-15 / Claude Code — Neon development + remote authentication verification

- Branch `milestone-3` (Milestone 3 commit `2bdf4e9` preserved).
- Neon development branch fully set up (NEON-DEV-01 PASS): restricted roles created with SQL, owner grants, comment marker, approved migrations 2/2, runtime suite 8/8; `ar-creator-db-dev` Hyperdrive → `ar_app`, caching disabled.
- Isolated Worker `ar-creator-dev` deployed with approval (`https://ar-creator-dev.quiet-dawn-af59.workers.dev`); `BETTER_AUTH_SECRET` set by the owner via a pipe (never displayed); REMOTE-AUTH-01 **9/9**.
- Production untouched: `ar-creator` Worker never deployed; `ar-creator-db` still `neondb_owner`; production Neon not migrated.
- Open: Resend (email flows remotely), sign-in CPU reading, production role/migration/rotation (approval each), Milestone 4 (not started; awaiting the owner's review of the remote results).
- To remove the dev Worker: `npx wrangler delete --name ar-creator-dev`.

## Session handoff — 2026-11-15 (2) / Claude Code — Phase 1 Milestone 4 (experience management)

- Branch `milestone-4` (from `milestone-3` @ `d9b2c05`).
- Built: experiences API + scene configuration API (ADR-021), migration `0002_draft_version`, dashboard / new / experience pages with placement selector, autosave, conflict recovery, placement review, readiness.
- Verified locally: typecheck; Vitest 134; DB 43; integration 48; USD 55; Playwright 46; npm audit 0; desktop and phone screenshots reviewed (two fixes: dialog copy, phone header).
- **Not verified remotely:** migration 0002 is not applied to Neon development; `ar-creator-dev` still runs the Milestone 3 build. Both need owner approval.
- Not in scope: asset uploads and the tracking-image picker (Milestone 5), visual scene editor (Phase 3), publishing.
- Next: with approval, `db:remote migrate --env development` (0002), `deploy:dev`, add experience checks to the remote suite; then Milestone 5 (R2 asset storage).

## Session handoff — 2026-11-22 / Claude Code — Phase 1 Milestone 5 (asset storage in R2)

- Branch `milestone-5` (from `milestone-4` @ `403027c`).
- Built: asset API with upload slots, Worker-streamed upload validated before commit, signed cookieless reads, quotas, draft asset-reference checks, delete protection (ADR-022); migration `0003_asset_uploads`; `ObjectStore` (R2 + memory); R2 bindings and the `deploy:dev` bucket guard; `/library` page and the tracking-image picker.
- Verified locally: typecheck; Vitest 155; DB 44; integration 71 (incl. 6 R2-adapter tests in workerd/Miniflare); Playwright 54; USD 55; npm audit 0; desktop and phone screenshots reviewed (3 fixes: filter label, button alignment, GB formatting).
- **Not verified remotely:** no R2 bucket exists; Neon development lacks migrations 0002 and 0003; `ar-creator-dev` still runs the Milestone 3 build. Each needs owner approval.
- Not built: thumbnails/derivatives, range requests, cleanup of stale upload slots, presigned/multipart strategies, model previews, WebP (ADR-009).
- Next: with approval, create `ar-creator-assets-dev`, `db:remote migrate --env development` (0002 + 0003), `deploy:dev`, extend the remote suite (experiences + assets); then Phase 2 (Image-to-AR conversion of uploaded images).

## Session handoff — 2026-11-22 (2) / Claude Code — remote verification of Milestones 4 + 5

- The owner created both R2 buckets, applied 0002 + 0003 to Neon development (new endpoint `ep-dark-butterfly-bctzb64e`) and redeployed `ar-creator-dev`.
- Checked read-only: health (build `a162f66`, migrations current); unauthenticated asset routes 401/404; both buckets private (no r2.dev URL, no custom domain); dev Hyperdrive → new endpoint as `ar_app`, caching disabled.
- Added `tests/remote/content.remote.spec.ts` (runs after the auth spec and waits out its rate limit; deletes everything it uploads). Dry run on the local workerd build 8/8; **owner's remote run 17/17** (REMOTE-AUTH-01 9/9 + REMOTE-CONTENT-01 8/8).
- **Phase 1 gate met on the dev environment.** Production (Worker, Neon, `ar-creator-assets`) untouched.
- Open: Resend; Workers CPU reading; production roles/migrations/rotation (approval each); asset follow-ups (range requests, slot sweep, thumbnails); ESLint/Prettier; P0 device rows.
- Next: Phase 2 (Image-to-AR from uploaded images) when the owner says go.

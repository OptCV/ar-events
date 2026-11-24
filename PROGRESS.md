# PROGRESS.md — Actual Implementation State

**Updated:** 2026-11-22  
**State:** P0 runtime-proof kit (incl. Android WebXR image probe) implemented and **structurally validated / desktop-tested**. **First device result: AND-IMG-01 PARTIAL** (native WebXR image tracking + DOM overlay worked on one Android/Chrome 157 device; visual/geometry checks outstanding). All other device rows NOT TESTED. **Phase 1 Milestones 1–5 done locally and verified on the isolated dev environment** (`ar-creator-dev` Worker → Hyperdrive → Neon development, R2 `ar-creator-assets-dev`): REMOTE-AUTH-01 9/9, REMOTE-CONTENT-01 8/8 (2026-11-22). Production not deployed or migrated.  
**Current phase:** Phase 2 Milestone 8 (WebP, rotated photos, 2048 px texture budget; ADR-025) **done and verified on the dev edge** (Neon dev 6/6, remote run 19/19 incl. REMOTE-CONVERT-WEBP, 2026-11-22). **Phase 3 M9–M10 (scene editor workspace ADR-027; transforms, gizmos, undo/redo ADR-028) done locally** (M9–M10 deployed to dev); M11 (models, text, panels, shapes, budgets; ADR-029) deployed to dev. Phase 4 M12 (actions, ADR-030) deployed to dev. Phase 4 M13 (interaction plan, ADR-031) deployed to dev; Phase 4 gate met in code. **Phase 5 M14–M16 (scene compiler GLB ADR-032, USDZ ADR-033; test builds + device test links ADR-034) done locally.** M14–M16 deployed to dev; Neon dev 7/7; remote 21/21 incl. REMOTE-BUILD (2026-11-23). M17 (Android WebXR image viewer, ADR-035) deployed to dev — every runtime has a device path; the Phase 5 gate needs devices. Phase 6 M18 (publishing, ADR-036) on the dev edge (22/22); Phase 6 gate met in tests. M19 (sharing + anonymous analytics, ADR-037) on the dev edge (migration 0007 applied, 22/22). Phase 2 gate (native device checks) outstanding: checklist ready (`tests/device/phase-2-checklist.md`), "View in AR" added (ADR-026, local; needs redeploy). Milestones 6–7 **done locally** (ADR-023, ADR-024); both deployed to the dev Worker; **real Cloudflare Container conversion verified 2026-11-22 (REMOTE-CONVERT-01, 18/18)**. Milestone 6 (Image-to-AR conversion pipeline): GLB in the Worker, USDZ in a Cloudflare Container (Docker locally), driven by a Workflow. Not yet on Cloudflare: Neon migration 0004 and the first Container deploy need approval. Phase 1 is complete on dev (gate met on the edge with real R2). P0 device rows still open (AND-IMG-01 re-run, AND-IMG-02, iOS, Scene Viewer).

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
| 2026-11-22 | product owner (performed by the owner) | Applied migration `0004_image_to_ar_jobs` to Neon development; attempted `npm run deploy:dev -- --subdomain quiet-dawn-af59` (first Container deploy) | Neon development `ep-dark-butterfly-bctzb64e`; Worker `ar-creator-dev` | 0004 applied (health: migrations current). **Deploy failed**: Containers API 401 — the account has no Workers Paid plan. Wrangler had already uploaded and activated the Worker (version `3a8ad4a4-ef18-42ba-9ec2-3aae01e8d730`, build `70b9d33`) before the container step, so the dev Worker runs the M6 code **without** a Container application: conversions there cannot produce USDZ. |

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

## Session handoff — 2026-11-22 (3) / Claude Code — Phase 2 Milestone 6 (Image-to-AR conversion pipeline)

- Branch `phase-2` (from `milestone-5` @ `d071640`). Owner decision: USDZ conversion runs in Cloudflare Containers.
- Built: Workflow + Container conversion pipeline, streaming PNG alpha scanner, HTTP converter (`serve`), multi-stage converter image, migration `0004_image_to_ar_jobs`, conversion/derivative API with signed downloads, "Make AR object" page (ADR-023).
- Verified locally: typecheck; Vitest 207; DB 46; integration 92 (needs `npm run usd:serve`); USD 68; Playwright 58 (local Workflow engine + Docker converter); npm audit 0; `deploy:dev --dry-run` (builds the Container image; nothing uploaded); remote spec dry run against local workerd 9/9; desktop and phone screenshots reviewed.
- **Found:** `@cloudflare/vite-plugin` refuses local Containers on Windows ("use WSL"). Local dev and tests therefore reach the same image through Docker over HTTP. **The Container class, its cold start and the `basic` sizing stay unverified until a Cloudflare deploy.**
- **Needs approval:** apply 0004 to Neon development; redeploy `ar-creator-dev` (first Container deploy: pushes the image to Cloudflare's registry; the account must be on Workers Paid); then run REMOTE-CONVERT.
- Device: rendering of generated GLB/USDZ in Scene Viewer and Quick Look is NOT TESTED.
- Next: with approval, the remote steps above; then M7 (3D preview, add to an experience).

### Addendum — 2026-11-22 (4): first Container deploy blocked (no Workers Paid)

- Owner applied 0004 to Neon development (health: migrations current). The dev deploy failed: `GET /accounts/…/containers/me` → 401; `wrangler containers list` (read-only) says: "You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan." The OAuth token does include `containers (write)`, so this is the account plan, not the login.
- **Partial deploy:** wrangler uploads and activates the Worker before the container step, so `ar-creator-dev` now runs version `3a8ad4a4…` (build `70b9d33`). Milestone 4/5 features keep working (health ok); conversions on dev cannot produce USDZ (expected outcome: the usdz step retries, then `converter_unavailable`; not observed).
- Fix: `deploy:dev` now runs `wrangler containers list` before the confirmation prompt and refuses with "Nothing was uploaded" when Containers are unavailable. Verified: the refusal fires and the live version stays `3a8ad4a4…`.
- Owner options: upgrade the account to Workers Paid, then re-run `deploy:dev` and the remote suite; or roll the dev Worker back to the Milestone 5 version `aec8691a-6a47-4406-90e4-1d76d119868a` (`npx wrangler rollback aec8691a-6a47-4406-90e4-1d76d119868a --name ar-creator-dev`, approval needed).

### Addendum — 2026-11-22 (5): Workers Paid, dev redeploy, owner account

- Owner upgraded the account to Workers Paid and ran `deploy:dev` successfully: `ar-creator-dev` version `f9096902-48f8-4097-80d9-cdf5dc3f1f0b` (build `afd101b`), container application `ar-creator-dev-usdconvertercontainer-dev` **ready** (0 live instances; read-only `wrangler containers list`). REMOTE-CONVERT not run yet.
- New `npm run db:remote -- create-user --env development --email <owner email>`: one verified account in Neon development for the owner while sign-up is off. Password typed twice at a hidden prompt, hashed with Better Auth, never printed; runs as `ar_app`; development only; refuses existing emails. Refusal paths tested; the full path runs in the owner's terminal (same inserts as `remote-auth-test`).

## Session handoff — 2026-11-22 (6) / Claude Code — Phase 2 Milestone 7 (preview and reuse)

- Built: lazy three.js 3D preview of the generated GLB; soft-edge highlight; `GET /api/image-objects`; Image objects panel on the experience page; draft references require a complete GLB + USDZ pair; source deletion blocked while placed (ADR-024).
- Verified locally: typecheck; Vitest 207; DB 46; integration 94; Playwright 60 (3D preview `ready` in headless Edge); npm audit 0; desktop and phone screenshots reviewed (2 fixes).
- Not on the dev Worker yet (needs `deploy:dev`). REMOTE-CONVERT (first real Container conversion) still to run.
- Device: AR rendering of image objects NOT TESTED; publishing/compilation of scenes is Phase 5.
- Next: owner account via `create-user`, redeploy, remote suite; then M8 (WebP/EXIF normalisation, texture budgets).

### Addendum — 2026-11-22 (7): remote conversion verified

- Owner created their development account with `create-user` (works end to end), redeployed (`ar-creator-dev` version `f0735057…`, build `f41be26`) and ran the remote suite: **18/18**, including REMOTE-CONVERT-01 (Workflow + Container, 8.7 s with a cold start). Neon development at 5/5 migrations.
- Container application `active`, 2 live instances after the run (pool of 3, 3 min sleep).

### Addendum — 2026-11-22 (8): dev container pool → 1

- At the owner's request, the dev Worker now uses one converter instance (`env.dev` `max_instances: 1`, `USD_CONVERTER_POOL=1`; guard in `deploy:dev`). Production config unchanged (3). Dry run passed; **not deployed yet** (owner runs `deploy:dev`). Trade-off: dev conversions run one at a time; after 3 idle minutes the next one pays a cold start (~several seconds).

## Session handoff — 2026-11-22 (9) / Claude Code — Phase 2 Milestone 8 (texture preparation)

- Verified first: dev redeploy took effect (build `1c315bd`, container application `max_instances: 1`).
- Built: still-WebP display uploads; `/v1/texture` in the converter (Pillow 13.0.0: WebP → PNG/JPEG, EXIF rotation, premultiplied downscale to 2048 px); a `texture` pipeline step that keeps original bytes when possible and otherwise stores one prepared texture used by both GLB and USDZ; migration `0005_texture_derivatives`; UI notes (ADR-025).
- Verified locally: typecheck; Vitest 212; DB 46; integration 96; USD 81; Playwright 62; npm audit 0; deploy dry run (image 465 MB); remote spec dry run 10/10.
- Found and fixed while testing: the conversion route still refused WebP sources; a test fixture (not the converter) had dark edge pixels; Pillow premultiplies RGBA on resize by itself (documented; the fringe test cannot tell the two apart).
- **Needs approval/owner:** apply 0005 to Neon development **before** redeploying (otherwise health reports migrations behind), then `deploy:dev` and the remote suite.
- Open: 2048 px budget unconfirmed on devices; colour profiles not converted; tracking-image WebP unsupported; device rendering NOT TESTED.

## Session handoff — 2026-11-22 (10) / Claude Code — Milestone 8 on the dev edge

- Owner applied 0005 to Neon development (6/6), redeployed (`ar-creator-dev` version `4bd1bd1c…`, build `e8de023`) and ran the remote suite: **19/19**. REMOTE-CONVERT-WEBP passed (Pillow in the Cloudflare Container, 6.5 s); REMOTE-CONVERT 17.9 s with the 1-instance pool.
- Read-only check afterwards: container application active, 1 live instance.
- Open: Phase 2 gate needs devices (alpha fixtures through the product on iPhone and Android); 2048 px budget; ICC profiles; tracking-image WebP; production roles/migrations and `neondb_owner` rotation (approval).

## Session handoff — 2026-11-22 (11) / Claude Code — Phase 2 device checklist and "View in AR"

- Wrote `tests/device/phase-2-checklist.md` (gate session for IOS-ALPHA-01 / AND-ALPHA-01 with product-generated files, plus orientation, size and Milestone 8 cases); added P2-* matrix rows (all NOT TESTED).
- Added reproducible device inputs `orientation_probe_exif6.jpg` and `ring_4096.png` (generator run twice, identical SHA256SUMS; the local converter turns them into an upright 600 × 400 JPEG and a 2048 × 2048 PNG).
- Found while writing it: Android had no way to open product files in Scene Viewer, and a reloaded page hid the latest result. Added "View in AR" (ADR-026) and newest-version-by-default.
- Verified locally: typecheck; Vitest 215; Playwright 64; phone screenshot reviewed. Integration/USD suites unaffected (no API or converter change).
- **Owner:** redeploy dev (`npm run deploy:dev -- --subdomain quiet-dawn-af59`, no migration), run the remote suite (REMOTE-VIEW-IN-AR new), then the device checklist.

## Session handoff — 2026-11-22 (12) / Claude Code — first phone checks

- Remote 20/20 on the ADR-026 build (REMOTE-VIEW-IN-AR pass). Owner: Quick Look works on iOS; Scene Viewer does not open on Android; desktop preview grey.
- Fixed grey preview (CSP `connect-src blob:`, same cause as the P0 lab); preview now flags a missing texture. Added cross-origin read headers on signed GLB/USDZ responses (suspected Scene Viewer cause, unconfirmed).
- Verified locally: typecheck; Vitest 215; integration 96; Playwright 64 (and the texture check fails with the old CSP).
- Next: owner redeploys and retries View in AR on Android; report what happens on tap.

## Session handoff — 2026-11-22 (13) / Claude Code — Phase 3 Milestone 9 (scene editor workspace)

- Owner deferred the Android Scene Viewer issue (believed to be a known Scene Viewer bug); recorded in TASKS.
- Planned Phase 3 (ROADMAP: M9 workspace/viewport, M10 transforms + undo/redo, M11 more content; gate = roundtrip + real dimensions).
- Built M9: `apps/web/src/editor/` (SceneEditor, Viewport, sceneModel + tests, Editor.module.css); the image-object panel became the editor's picker.
- Found and fixed a lost update in the draft editor (async upload saving a stale scene); regression test verified to fail on the old code.
- Verified locally: typecheck; Vitest 220; Playwright 69; screenshots at 1400/390 px; three.js still only in lazy chunks (main bundle +7 kB).
- Not deployed. Next: M10 (transforms, gizmos, snapping, undo/redo).

## Session handoff — 2026-11-22 (14) / Claude Code — Phase 3 Milestone 10 (transforms and history)

- Owner redeployed M9 to dev.
- Built M10: `transforms.ts` + `history.ts` (pure, unit-tested), Viewport hierarchy + TransformControls gizmos + bounds-based align API, inspector fields, toolbar, lock/duplicate/remove, keyboard shortcuts.
- Found and fixed while testing: moving from one transform field to another applied the first and re-created the form, losing what was typed in the second.
- Verified locally: typecheck; Vitest 227; Playwright 74 (gizmo test repeated 8×); screenshots at 1400/390 px. three.js stays in lazy chunks (Viewport chunk 9 kB gzip; main bundle +2 kB).
- Not deployed. Next: M11 (models, text, panels, shapes; asset library in the editor; per-object budgets).

## Session handoff — 2026-11-22 (15) / Claude Code — Phase 3 Milestone 11 (more content and budgets)

- Owner redeployed M10.
- Built M11: canonical built-in geometry (schema `content.ts`, optional shape colour), `builtins.ts` (canvas text/panels, shapes), models from the library or uploaded in the editor, `budgets.ts` (Scene Viewer numbers), scene budget, "In AR" notes (registry + new `shape` feature), ContentFields.
- Found and fixed while testing: sizes were measured after the node scale was applied.
- Verified locally: typecheck; Vitest 233; integration 96; Playwright 80; screenshot reviewed. Main bundle +4 kB gzip; three.js still lazy.
- Not deployed. **Phase 3 gate** (roundtrip for every node kind + real dimensions in the editor) is covered by tests for image objects, models, text, panels and shapes; device dimension checks remain with the Phase 2 checklist. Groups and hotspots have no editor UI yet (hotspots belong to P4 actions).

## Session handoff — 2026-11-22 (16) / Claude Code — Phase 4 Milestone 12 (actions in the editor)

- Owner redeployed M11. Planned Phase 4 (ROADMAP: M12 actions in the editor, M13 interaction plan + compatibility matrix; gate: no unsupported action silently disappears).
- Built M12: `actions.ts` (pure: descriptions, validation via schema, primary/tap rules, cascading deletes that report what went), ActionsPanel, "On tap" field, hotspots (marker), undo over nodes + actions, animation clip names from loaded models.
- Verified locally: typecheck; Vitest 239; Playwright 83; actions panel screenshot.
- Not deployed. Next: M13 — the per-viewer interaction plan, compatibility matrix and experience-page preview.

## Session handoff — 2026-11-22 (17) / Claude Code — Phase 4 Milestone 13 (interaction plan)

- Owner redeployed M12.
- Built M13: `interactions.ts` in capabilities (plan per runtime, page plan, issues, features used, launcher options), readiness API warnings, CompatibilityPanel (matrix, warnings, page preview), shared SUPPORT/FEATURE labels.
- Phase 4 gate: exhaustive unit test (192 runtime checks) — no action disappears silently.
- Found and fixed: the matrix widened the page on phones; nested quotation marks in messages; redundant "X — X" option labels.
- Verified locally: typecheck; Vitest 245; integration 97; Playwright 88; screenshots at desktop and 390 px. Main bundle 178 kB gzip (+6 kB since M11).
- Not deployed. Next: Phase 5 — exporters (multi-node USDZ and composed Scene Viewer GLB) and hosted viewers that execute this plan.

## Session handoff — 2026-11-23 (18) / Claude Code — Phase 5 Milestone 14 (scene compiler: composed GLB)

- Owner redeployed M13. Planned Phase 5 (ROADMAP: M14 composed GLB, M15 USDZ, M16 compile pipeline + device test links, M17 WebXR image viewer; gate needs devices).
- Built M14 in the converter container: `scene/request.py`, `scene/gltf.py` (reader/writer/lossless merger), `scene/builtins.py` (geometry, text/panel rasters), `scene/compose_glb.py`, `/v1/scene/glb`; vendored DejaVu Sans (2.37 release zip SHA-256 7576310b…, TTF hashes in SHA256SUMS); Worker-side request builder; editor uses the same font.
- Verified locally: typecheck; Vitest 246; USD 90; integration 99 (glTF Validator 0 errors/0 warnings); Playwright 88; deploy dry run (image builds).
- Not deployed (no Worker route uses the compiler yet). Next: M15 — the USDZ exporter for the same scenes.

## Session handoff — 2026-11-23 (19) / Claude Code — Phase 5 Milestone 15 (scene USDZ)

- Built M15: `scene/gltf_to_usd.py` (static glTF → USD with PBR materials; warnings for what is not carried over; compressed meshes refused), `scene/compose_usdz.py` (anchoring, nodes, built-ins, packaging, validation), `/v1/scene/usdz`; inspector "On iPhone" notes for models.
- Verified locally: typecheck; Vitest 246; USD 97; integration 101; Playwright 89; deploy dry run.
- Not deployed (nothing calls the compiler yet). Next: M16 — compile pipeline (Workflow) and short-lived device test links, which make the first device runs of compiled scenes possible.

## Session handoff — 2026-11-23 (20) / Claude Code — Phase 5 Milestone 16 IN PROGRESS (stopped: usage limit)

- Done (typecheck clean; Vitest 246; DB 47): contracts `builds.ts` (BuildSummary, TestBuildResponse, BUILD_ERRORS, limits) + conflict reasons `not_ready`, `build_running`; DB schema + migration **0006_build_outputs** (revision state `ready`, `content_hash` unique per experience and immutable via the updated trigger, `generated_outputs.size_bytes` required when ready) with integrity tests; converter client `scene('glb'|'usdz', request, sha)`.
- Migration 0006 is applied to LOCAL Postgres only. **Not applied to Neon development — needs the owner's approval.**
- Remaining for M16: signing kinds `output`/`build`; `compile/pipeline.ts` (start → GLB step → USDZ step → finish; per-output failure → partially_ready); Workflow param `kind: 'build'` in the existing workflow class + inline runner; routes (POST /api/experiences/:id/builds, GET build, GET /api/test-builds/:id signed, GET /api/outputs/:id/content signed with CORP cross-origin); web "Test on device" panel + /test/:id page (Quick Look banner + tap handler, Scene Viewer intent with link, desktop 3D preview + QR via qrcode-generator 2.0.4); integration + browser tests; ADR-034; docs.

## Session handoff — 2026-11-23 (21) / Claude Code — Phase 5 Milestone 16 complete (locally)

- Finished M16 on top of the WIP commit: signing kinds `output`/`build`; `compile/pipeline.ts` (plan with publish readiness, content hash, per-platform steps, partially_ready); Workflow `kind: 'build'`; routes (builds, public test page, compiled files with CORP); experience deletion removes build files; asset "in use" now only counts draft + published revisions; web "Test on device" panel + `/test/:id` page + QR.
- Verified locally: typecheck; Vitest 247; DB 47; integration 105; Playwright 96; REMOTE-BUILD dry run against the dev server. (Docker Desktop had stopped; restarted it and the local Postgres/converter.)
- **Needs the owner:** apply migration 0006 to Neon development (`npm run db:remote -- migrate --env development --host ep-dark-butterfly-bctzb64e.c-16.us-east-1.aws.neon.tech`), then `deploy:dev`, then the remote suite (REMOTE-BUILD is new). Then the first device runs of compiled scenes (tests/device/phase-2-checklist.md §Phase 5).

## Session handoff — 2026-11-23 (22) / Claude Code — M16 on the dev edge

- Owner applied 0006 to Neon development (7/7), redeployed, remote suite 21/21: REMOTE-BUILD passed (Workflow + Container compile in 6.3 s; signed test link works without a session).
- Next: M17 (Android WebXR image viewer); device runs of test builds.

## Session handoff — 2026-11-23 (23) / Claude Code — Phase 5 Milestone 17 (Android image viewer)

- Built: `apps/web/src/builds/xr/` (ImageViewer + pure interactions + tests), `xr` data in the test-build response, Android image routing on the test page.
- Verified locally: typecheck; Vitest 251; integration 106; Playwright 98; deploy dry run. (Docker Desktop had stopped again; restarted.)
- Not deployed. Next: redeploy (no migration), then the Phase 5 gate — device runs for all six runtimes (tests/device/phase-2-checklist.md §Phase 5). Follow-up: the main bundle grew to 190 kB gzip; lazy-load the test page route.

## Session handoff — 2026-11-23 (24) / Claude Code — Phase 6 Milestone 18 (publishing)

- Owner redeployed M17. Planned Phase 6 (ROADMAP: M18 publishing, M19 public page + analytics, M20 hardening).
- Built M18: `promoteBuild` + publish-on-ready in the build pipeline; routes publish/unpublish/publication/public; shared `viewerBody`/`ensureBuild`; `/x/:slug` page (shared viewer with the test page); Publish panel.
- Verified locally: typecheck; Vitest 251; DB 47; integration 109 (incl. the Phase 6 gate); Playwright 100; deploy dry run. No migration.
- Next: redeploy (no migration) + remote suite; then M19.

## Session handoff — 2026-11-23 (25) / Claude Code — M18 on the dev edge

- Owner redeployed M18; remote suite 22/22 incl. REMOTE-PUBLISH. Next: M19 (public page + analytics).

## Session handoff — 2026-11-23 (26) / Claude Code — Phase 6 Milestone 19 (sharing + analytics)

- Built: migration 0007 `analytics_daily`; `apps/api/src/analytics/routes.ts` (public events, owner summary); tracker on the public page (view once per tab, AR taps, link taps incl. Quick Look banner and WebXR overlay); Share; print sheet; visits in the Publish panel.
- Verified locally: typecheck; Vitest 251; DB 48; integration 110; Playwright 102 (one unrelated flaky failure in a full run, passed on rerun); deploy dry run.
- **Needs the owner:** apply 0007 to Neon development, then deploy, then the remote suite. Next: M20 (hardening).

## Session handoff — 2026-11-23 (27) / Claude Code — M19 on the dev edge

- Owner applied migration 0007 to Neon development, redeployed; remote suite 22/22 (migrations 8/8) incl. anonymous counting. Next: M20 (hardening).

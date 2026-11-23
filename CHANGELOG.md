# CHANGELOG.md

This changelog records actual specification and implementation changes. Do not claim features are shipped because they are listed in a prompt.

## 2026-11-23 — Phase 5 Milestone 16: test builds and device test links (local)

### Added
- "Test on device" in the editor: builds the saved draft into the real Android GLB and iPhone USDZ (through the Workflow and the converter container), with a 24-hour signed link and QR code. ADR-034.
- Public test page `/test/:id`: Quick Look (main button as the banner) on iPhone, Scene Viewer (main button as `link`) on Android floor/wall, QR code and 3D preview on desktop, every link on all devices.
- Migration `0006_build_outputs`; API for builds, test pages and compiled files; remote check REMOTE-BUILD.

### Changed
- Assets used only by test builds can be deleted (builds keep their own copies); deleting an experience removes its build files; only the latest test build per experience is kept.
- The 3D preview no longer calls files without pictures "shape only".

## 2026-11-23 — Phase 5 Milestone 15: scene USDZ for Quick Look (local)

### Added
- `POST /v1/scene/usdz`: the same scene compiled to an anchored USDZ (image reference image, horizontal or vertical plane), with our own glTF → USD converter for image objects and models, and the same shapes, text and panels. Deterministic, structurally validated. ADR-033.
- The inspector says what a model loses on iPhone (animation; compressed meshes cannot be exported yet).

## 2026-11-23 — Phase 5 Milestone 14: scene compiler, composed GLB (local)

### Added
- Scene compiler in the converter container: `POST /v1/scene/glb` composes one GLB from a scene (image objects and models merged losslessly; shapes; text and panels rendered with a bundled font), deterministic, Scene Viewer's 15 MB limit enforced. ADR-032.
- Bundled DejaVu Sans for text and panels, used by both the compiler and the editor; Khronos glTF Validator in the integration tests.
- `apps/api/src/compile/sceneRequest.ts`: builds compile requests from a scene (used by the M16 pipeline).

### Changed
- The editor draws text and panels with the bundled font (waits for it to load), so its preview matches the exported files.

## 2026-11-22 — Phase 4 Milestone 13: interaction plan and compatibility matrix (local)

### Added
- Interaction plan per AR viewer (`packages/capabilities`): where the main button and every action end up; launcher parameters for Quick Look and Scene Viewer. ADR-031.
- Editor Compatibility section: matrix per viewer, warnings, preview of the experience page's buttons.
- Publish check warns about actions a viewer cannot run, taps and hotspots in Quick Look/Scene Viewer, animations that cannot start on request, and unused behaviours.

## 2026-11-22 — Phase 4 Milestone 12: actions in the editor (local)

### Added
- Actions panel: web link, email, phone, show/hide an object, play a model animation; edit and delete; "Used by" for each action; the main button (web links only).
- "On tap" for every object; hotspots (need an action; drawn as a marker in the editor). ADR-030.

### Changed
- Removing an object also removes the actions that show/hide or animate it and hotspots left without an action, and says so; undo now restores objects and actions together.

## 2026-11-22 — Phase 3 Milestone 11: models, text, panels, shapes, budgets (local)

### Added
- Editor "Add" menu: image object, 3D model (from the library or uploaded in place), text, panel and shape; inspector fields for text (content, colour, line height), panels (title, text) and shapes (box/sphere/cylinder/flat square, colour).
- Per-object budget (triangles, materials, textures) and scene budget with Scene Viewer guidance; "In AR" notes per object from the capability registry. ADR-029.
- Schema: optional `color` on shapes; canonical sizes of built-in content (`packages/schema/src/content.ts`).

## 2026-11-22 — Phase 3 Milestone 10: transforms, gizmos, undo/redo (local)

### Added
- Inspector position (cm), rotation (°) and scale (%) fields; Move/Rotate/Scale handles in the 3D view (Q/W/E/R) with snapping (1 cm, 15°, 5 %); Lock, Duplicate (Ctrl/⌘+D), Remove (Delete); Put on floor / Put on image / Flush to wall / Fit to image using the object's real bounds; Undo/Redo (buttons and Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl+Y). ADR-028.
- The 3D view follows the scene hierarchy (children move with their parent).

## 2026-11-22 — Phase 3 Milestone 9: scene editor workspace (local)

### Added
- Scene editor on the experience page: object tree, 3D viewport (anchor drawn per placement mode in canonical axes, the tracking image at its printed size, image objects from their GLBs), inspector with the object's real size; select from the list or the view; show/hide, rename, remove. ADR-027.

### Fixed
- An object added while a tracking image was still uploading could disappear when the upload finished (the upload saved an older copy of the scene). Draft edits are now applied to the latest scene.

### Changed
- An image object can be placed more than once; removing it is done in the inspector.

## 2026-11-22 — Fixes from the first phone and desktop checks

### Fixed
- Desktop 3D preview showed the shape in grey: the CSP blocked three.js from reading the GLB's embedded texture (`connect-src` now allows `blob:`). The preview now says when only the shape could be loaded.
- Generated GLB/USDZ responses allow cross-origin reads (`Cross-Origin-Resource-Policy: cross-origin`, `Access-Control-Allow-Origin: *`) on valid signed URLs, for native viewers. Suspected cause of Scene Viewer not opening; unconfirmed until retried on the device.

### Verified
- Remote run 20/20 incl. REMOTE-VIEW-IN-AR on the redeployed dev Worker.

## 2026-11-22 — Phase 2 device checklist and "View in AR"

### Added
- `tests/device/phase-2-checklist.md`: the Phase 2 gate session (transparency, orientation, size, Milestone 8 inputs, fallbacks, recording); P2-* rows in the device matrix.
- Device-test inputs `normalize/orientation_probe_exif6.jpg` (EXIF 6) and `normalize/ring_4096.png` (4096 px), generated reproducibly with the WebP fixtures.
- "View in AR" on the Make AR object page: Quick Look on iPhone/iPad, Scene Viewer (floor) on Android, explained fallbacks (ADR-026). Remote check REMOTE-VIEW-IN-AR.

### Changed
- The Make AR object page shows the newest version on load (previously only after converting in the same visit); conversion links refresh when the tab becomes visible.

## 2026-11-22 — Remote verification of Phase 2 Milestone 8

### Verified
- Neon development at 6/6 migrations; dev Worker build `e8de023`. REMOTE-CONVERT-WEBP: a soft-alpha WebP prepared as PNG by Pillow inside the Cloudflare Container and converted, 6.5 s. Full remote run 19/19.

## 2026-11-22 — Phase 2 Milestone 8: WebP, rotated photos and a texture budget (local)

### Added
- Display images accept still WebP uploads (tracking images stay PNG/JPEG).
- Texture preparation in the converter container (`/v1/texture`, Pillow 13.0.0): WebP → PNG/JPEG, EXIF rotation applied, images above 2048 px downscaled in premultiplied alpha. Stored once as an `image_object_texture` derivative; GLB and USDZ embed the same bytes. Migration `0005_texture_derivatives`.
- Conversion results report what was done to the image; the page warns before converting large or WebP images.
- WebP fixtures (`tests/fixtures/normalize`, generated reproducibly in the sandbox); remote check REMOTE-CONVERT-WEBP. ADR-025.

### Changed
- EXIF-rotated JPEGs are converted (turned upright) instead of refused.
- GLB/USDZ provenance versions include the texture policy; conversion job keys use a version digest.

## 2026-11-22 — Dev converter pool reduced to one instance

### Changed
- Converter pool size is the `USD_CONVERTER_POOL` var (clamped to 1–3; missing or invalid → 1). `env.dev`: 1 instance (`max_instances: 1`) to cut Containers cost; production unchanged at 3. `deploy:dev` refuses any other dev value.

## 2026-11-22 — Remote verification of Phase 2 conversion

### Verified
- REMOTE-CONVERT-01 on `ar-creator-dev` (Workers Paid): a display PNG converted through the Workflow, the Worker (GLB) and the Cloudflare Container (USDZ) in 8.7 s including a cold start; outputs read back through signed URLs with correct types and checksums. Full remote run 18/18.

## 2026-11-22 — Phase 2 Milestone 7: 3D preview, soft edges, image objects in experiences (local)

### Added
- 3D preview of the generated GLB on the "Make AR object" page (three.js 0.186.1, lazy-loaded; orbit, 10 cm grid, background follows the 2D preview).
- "Highlight partly transparent pixels" on the 2D preview (magenta overlay with the share).
- Experience page: **Image objects** — add a finished image object, see size/transparency/sides, remove. `GET /api/image-objects`.
- `npm run db:remote -- create-user`: owner account in Neon development while sign-up is off (hidden password prompt). ADR-024.

### Changed
- Draft saves require an image-object node to reference the GLB of a complete GLB + USDZ pair.
- Deleting a source image is refused while an experience uses an image object made from it.

## 2026-11-22 — Dev deploy preflight for Containers

### Fixed
- `deploy:dev` checks Cloudflare Containers access (`wrangler containers list`) before asking for confirmation. Without it, an account lacking Workers Paid got a half-deployed Worker: wrangler activates the Worker before it pushes the container image. Observed on the first M6 dev deploy.

## 2026-11-22 — Phase 2 Milestone 6: Image-to-AR conversion pipeline (local)

### Added
- Conversion API: `POST/GET /api/assets/:id/image-objects`, `GET /api/conversions/:id`, `GET /api/derivatives/:id/content` (signed, cookieless; `?download=1`). Contracts in `packages/contracts/src/conversions.ts`.
- Cloudflare Workflow `ImageToArWorkflow` (one instance per attempt; steps start → glb → usdz → finish; user errors are not retried) and Container class `UsdConverterContainer` (internet disabled, `basic`, max 3). Bindings `IMAGE_TO_AR` and `USD_CONVERTER` in production and `env.dev`.
- `python -m usd_processor serve`: HTTP converter for the Container. Dockerfile split into `base` / `test` / `runtime` stages; `npm run usd:serve` runs the runtime image locally on 127.0.0.1:8790.
- `scanPngAlpha` (streaming alpha statistics for any PNG without a full decode) and `jpegOrientation` in `packages/image-to-ar`.
- Migration `0004_image_to_ar_jobs` (job input and error code; derivative size and checks).
- UI: "Make AR object" on display images → `/library/:assetId/ar-object` with preview backgrounds, settings, live status, downloads and earlier versions.
- Tests: scanner, converter client, HTTP converter (pytest), conversion integration tests against the real converter image, browser flows with the local Workflow engine; remote check REMOTE-CONVERT (not yet run). ADR-023.

### Changed
- Generated outputs count toward the storage quota. Deleting a source removes its generated files and is refused while it is converting.
- Signed URLs carry a kind (asset or derivative) in the signed message and the path.
- `deploy:dev` also requires the dev Workflow name and at most 3 container instances.
- Local dev: `dev.enable_containers` is false (Containers cannot run locally on Windows); `USD_CONVERTER_URL` in `.dev.vars` points the Workflow at the Docker converter.

## 2026-11-22 — Remote verification of Milestones 4 + 5

### Added
- Remote suite `tests/remote/content.remote.spec.ts` (experiences, R2 uploads, signed reads, rejections, browser library, cleanup); runs with the auth suite via `db:remote -- remote-auth-test`.

### Verified
- REMOTE-CONTENT-01 8/8 on `ar-creator-dev` with real R2 (`ar-creator-assets-dev`) and Neon development (migrations 4/4); auth suite re-run 9/9. Both R2 buckets confirmed private. Neon development endpoint is now `ep-dark-butterfly-bctzb64e` (NEON.md).

## 2026-11-22 — Phase 1 Milestone 5: asset storage in R2 (local)

### Added
- Asset API: `POST /api/assets/uploads` (upload slot + strategy-neutral upload target), `PUT /api/assets/:id/content` (Worker-streamed upload, validated before commit), `GET /api/assets` (+ usage), `GET/DELETE /api/assets/:id`, `GET /api/assets/:id/content` (HMAC-signed, cookieless private read). Ownership enforced in SQL.
- Streaming pipeline: head inspection before any byte is stored, exact-size enforcement, SHA-256 (native `DigestStream` in workerd), PNG end-marker check, optional client checksum (also verified by R2).
- Inspection: PNG/JPEG by signature with header-only dimensions and bomb limits; tracking-image minimum and warnings; self-contained GLB 2.0 only (external URIs refused).
- `ObjectStore` interface with R2 and in-memory adapters; `ASSETS_BUCKET` bindings (`ar-creator-assets`, `ar-creator-assets-dev`); `deploy:dev` refuses any other bucket.
- Migration `0003_asset_uploads`; asset contracts in `packages/contracts`.
- Draft saves verify referenced assets (owned, validated, right role); assets in use cannot be deleted.
- UI: asset library (`/library`) with role choice, drag-and-drop, progress, cancel, previews, usage, filters, delete; tracking-image picker with printed size on the experience page; "Library" nav link.
- Tests: asset unit tests, integration tests, an R2 adapter test in workerd (Miniflare), browser flows. ADR-022.

### Changed
- The CSRF guard accepts a non-JSON body only for `PUT /api/assets/:id/content` (Origin still required).
- API responses keep `Cache-Control: no-store` unless a route sets its own (signed reads: private, short-lived).
- Shared API error helpers (`apps/api/src/http.ts`); a duplicated `/api/session` route was removed.

### Status
- Verified locally only (including local R2 simulation). No R2 bucket created; Neon development still needs migrations 0002 and 0003; `ar-creator-dev` not redeployed.

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

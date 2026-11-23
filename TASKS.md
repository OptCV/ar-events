# TASKS.md — Tracked Implementation Backlog

**Legend:** `[ ]` not started, `[-]` in progress (keep only while active), `[x]` done with actual evidence in `PROGRESS.md` / `TESTING.md`.
Where a task has an automated half and a device half, they are tracked separately; a `[x]` on the automated half never implies the device half.

## P0: Feasibility

- [x] Build smallest image-anchored USDZ fixture and inspect anchor metadata. *(structurally validated: `out/p0/usdz/img-overlay.usdz`, pytest `test_anchoring_metadata`)*
- [x] Build horizontal/vertical plane-anchored USDZ fixtures. *(structurally validated: `floor-probe`, `wall-probe`)*
- [x] Create alpha PNG GLB and USDZ conversion fixtures. *(9 deterministic fixtures; GLB passes Khronos glTF-Validator; USDZ passes ADR-008 validation)*
- [x] Scene Viewer intent + Quick Look href builders with injection tests (`packages/platform-launch`).
- [x] P0 device-lab page generator (`npm run p0:build`) with matched GLB/USDZ pairs and launch links.
- [ ] Deploy P0 device lab to HTTPS (`infra/p0-lab/wrangler.jsonc`) — needs the owner's Cloudflare account.
- [ ] Verify iOS image anchor tracking on real device and record OS/device. (IOS-IMG-01)
- [ ] Verify iOS horizontal and vertical plane anchoring + axis hypothesis H1. (IOS-FLR-01, IOS-WAL-01)
- [ ] Visually test alpha fixtures in Quick Look and Scene Viewer. (IOS-ALPHA-01, AND-ALPHA-01)
- [ ] Prototype Android Scene Viewer floor launch via hosted GLB on device. (AND-FLR-01)
- [ ] Prototype Android Scene Viewer wall with `enable_vertical_placement=true` + hypothesis H2. (AND-WAL-01)
- [ ] Test Scene Viewer `link` and Quick Look banner CTA on device. (AND-LINK-01, IOS-LINK-01)
- [x] Android WebXR image-tracking probe page: adapter, preflight, tracker state machine, DOM overlay, JSON report (`packages/webxr-image`, `apps/p0-webxr-probe` → `out/p0/webxr/`; ADR-010). *(unit + desktop e2e only)*
- [-] Run the WebXR probe on an ARCore Android phone with Chrome "WebXR Incubations" on, and with it off. (AND-IMG-01 **PARTIAL** 2026-11-14: tracking, trackable score, DOM overlay verified on Chrome 157; visual/H3/re-acquire/device identity outstanding. AND-IMG-02 not run.)
- [x] Probe 0.2.0: fix evidence gaps found on device (width echo, reduced UA, tester observations, frame counts; ADR-012).
- [ ] Re-run AND-IMG-01 with probe 0.2.0 and fill all tester observations; run AND-IMG-02 (flag off).
- [x] Byte-reproducible USDZ output (ADR-011).
- [ ] Benchmark Cloudflare Containers conversion resource requirements (local Docker baseline recorded in `TESTING.md`).
- [ ] Run Apple `usdchecker` (macOS) on the P0 USDZ set as an extra gate (ADR-008).

## P1: Cloudflare and data

Plan and slice order: `ROADMAP.md` "Phase 1 plan".

- [x] Decide authentication provider: Better Auth (ADR-013), spike `spikes/auth-workers` 16/16 in local workerd.
- [x] Owner decisions: Neon (US East) + Hyperdrive, Resend, Workers Paid, Worker-streamed uploads designed for presigned/multipart later (ADR-015).
- [x] **Milestone 1 / P1-1** skeleton: `apps/web` (Vite + React 19 + React Router 8 + TanStack Query + CSS Modules) and `apps/api` (Hono) as one Worker via `@cloudflare/vite-plugin`; `packages/contracts`; `/api/health`; SPA fallback; security headers; dev and production builds verified in local workerd (ADR-016).
- [ ] First Cloudflare deploy of the skeleton (needs account; verify `run_worker_first`, `_headers`, SPA fallback on the edge).
- [ ] ESLint/Prettier (still not configured).
- [x] **Milestone 2 / P1-2** `packages/db`: Drizzle schema (Better Auth tables + experiences, revisions, assets, derivatives, jobs, outputs), migrations 0000–0001 incl. immutability triggers, local Postgres in Docker, per-request Hyperdrive connections, `/api/health` database check (ADR-017). Verified locally.
- [x] Neon role model + guarded remote tooling (`db:remote`, `infra/db/NEON.md`, ADR-018); rehearsed locally 10/10.
- [x] Neon development setup (2026-11-15): branches identified (`ep-plain-unit-bcruyo1j` = production, `ep-weathered-resonance-bce5rdkp` = development); SQL-created `ar_migrator`/`ar_app` (Console roles had `neon_superuser` and were deleted); grants; comment marker.
- [x] Preflight, approved migration (2/2) and verify 8/8 on Neon development (NEON-DEV-01).
- [x] `ar-creator-db-dev` Hyperdrive → `ar_app` (caching disabled). Production `ar-creator-db` still `neondb_owner` (later, with approval).
- [ ] Apply migrations to Neon production — **only with owner approval** (`--approved`; procedure in NEON.md).
- [ ] Edge verification of Hyperdrive: deploy, `/api/health` shows `database.status: ok`, confirm caching disabled (`wrangler hyperdrive get`), check latency.
- [ ] Rate limiting or brief caching for `/api/health` before public launch (it opens a DB connection per call).
- [x] **Milestone 3 / P1-3 (local):** Better Auth 1.7.16 in `apps/api` (per-request instance, allowlisted endpoints, fail-closed config, DB rate limits, token stripping, CSRF + redirect guards), `/api/auth-config`, `/api/session`, `/api/me`, `requireSession`; React sign-in/up, verify, forgot/reset, account, `RequireAuth`; dev mailbox; Resend mailer (ADR-019). Verified locally: integration 30/30, e2e 36/36.
- [x] P1-3 edge verification on the isolated `ar-creator-dev` Worker (REMOTE-AUTH-01, 9/9): Hyperdrive as `ar_app`, `__Secure-` cookies, immediate revocation, CF-Connecting-IP unspoofable, edge rate limiting, guards.
- [ ] Read sign-in CPU time in Workers Observability for `ar-creator-dev`.
- [ ] Production: `create-roles`/`migrate --approved`, switch `ar-creator-db` to `ar_app`, rotate production `neondb_owner` (possibly exposed). Each needs approval.
- [x] **Milestone 4 / P1-4 (local):** experiences CRUD + scene configuration API (draft PUT with optimistic concurrency, placement-change confirmation, publish readiness), ownership in SQL (cross-user → 404), migration `0002_draft_version`; dashboard, new-experience page with placement selector, experience page with autosave/conflict handling, readiness panel, delete (ADR-021).
- [x] Remote verification of M4 + M5 (2026-11-22): owner created `ar-creator-assets-dev` (+ `ar-creator-assets`), applied 0002 + 0003 to Neon development (new endpoint `ep-dark-butterfly-bctzb64e`) and redeployed `ar-creator-dev`; remote suite extended (`tests/remote/content.remote.spec.ts`); REMOTE-CONTENT-01 8/8, full run 17/17; both buckets confirmed private.
- [ ] Production: create/verify `ar-creator-assets` binding in a production deploy, apply 0000–0003 to production Neon — **approval each**.
- [x] **Milestone 5 / P1-5 (local):** R2 asset storage: upload slots (`POST /api/assets/uploads`, single-use, expiring), Worker-streamed upload validated before commit (magic bytes vs declared type, header-only dimension/bomb limits, self-contained GLB only, exact size, SHA-256, PNG end marker), explicit roles, per-user slot cap + quota, HMAC-signed cookieless private reads, ownership in SQL, draft asset-reference checks, delete blocked while in use; `ObjectStore` interface ready for presigned/multipart; migration `0003_asset_uploads` (ADR-022). R2 adapter verified in workerd against the local simulator only.
- [ ] Asset follow-ups: thumbnails/derivatives, HTTP range requests for signed reads, sweep expired/rejected upload slots, presigned-put and multipart strategies, rendered model previews.
- [x] P1-6 Dashboard UI: login, experience list, create draft (Milestone 4); asset library with upload progress/errors/previews and the tracking-image picker (Milestone 5). Verified locally (Playwright).
- [x] Email verification + password reset flows (dev mailbox locally).
- [ ] Resend: API key secret, verified sending domain, `EMAIL_FROM`; then real-delivery test. Public sign-up stays off until done.
- [x] Implement scene schema / discriminated placement union (`packages/schema`, v1; migrations pending).
- [-] Add migration, lint, typecheck and automated test scripts. *(typecheck + Vitest + pytest + Playwright (Edge channel) done; ESLint/Prettier and DB migrations pending)*

## P2: Image-to-AR

- [x] Distinguish tracking image vs displayed image asset role. *(schema `AssetRole`; explicit role on upload; separate limits and checks; draft references require the right role (ADR-022))*
- [x] Create checkerboard/size/alpha options UI. *(P2 M6: `/library/:assetId/ar-object` — transparency grid/light/dark preview, width cm/in with derived height, Auto/Cutout+threshold/Blend/Opaque, orientation, origin, sides (ADR-023))*
- [x] **P2 M6 (local):** conversion pipeline — Workflow per attempt, GLB in the Worker, USDZ from the converter image (Cloudflare Container in deployments; Docker locally), streaming PNG alpha analysis, idempotent jobs + derivative reuse, signed downloads, quota/limits, migration `0004_image_to_ar_jobs` (ADR-023).
- [x] P2 M6 remote (2026-11-22): 0004 applied; Workers Paid; dev Worker deployed with the Container + Workflow; REMOTE-CONVERT-01 PASS.
- [x] **P2 M7 (local):** 3D preview of the generated GLB (lazy three.js), soft-edge highlight, image objects placed in experiences (GLB id of a complete pair; source deletion blocked while placed), `GET /api/image-objects` (ADR-024).
- [x] Remote suite against the redeployed dev Worker (2026-11-22): 18/18; REMOTE-CONVERT-01 — first real Container conversion, 8.7 s including a cold start.
- [x] Dev container cost (2026-11-22): `ar-creator-dev` limited to 1 `basic` instance (`max_instances: 1`, `USD_CONVERTER_POOL=1`, enforced by `deploy:dev`); production stays at 3. Takes effect on the next `deploy:dev`.
- [x] GLB image-plane generator with `MASK` / `BLEND` (structurally validated; device check pending).
- [x] USDZ image-plane generator with alpha/opacity material (structurally validated; device check pending).
- [x] Normalize WebP and EXIF-rotated JPEG to PNG/JPEG before conversion (ADR-009 → ADR-025: prepared once in the converter container; WebP display uploads accepted).
- [x] Texture size limits / downscaled derivative for native viewer budgets. *(2048 px longest edge, premultiplied Lanczos, stored as `image_object_texture` (ADR-025); the budget still needs device confirmation)*
- [x] P2 M8 remote (2026-11-22): 0005 applied to Neon development (6/6), redeployed (`4bd1bd1c…`, build `e8de023`), remote suite 19/19 incl. REMOTE-CONVERT-WEBP (Pillow in the Container, 6.5 s).
- [x] Phase 2 device checklist (`tests/device/phase-2-checklist.md`) and "View in AR" on the Make AR object page (ADR-026); browser tests 64/64.
- [x] Redeploy dev with ADR-026 and run the remote suite (REMOTE-VIEW-IN-AR): 20/20.
- [ ] **Deferred (owner, 2026-11-22):** Scene Viewer does not open on the owner's Android phone; owner believes it is a recently known Scene Viewer bug. Later: collect the symptom, retry with the cross-origin headers (`8e15feb`), compare with modelviewer.dev's AR example on the same phone.
- [ ] Run the Phase 2 device checklist on one iPhone and one ARCore Android phone (gate).
- [ ] Colour profiles: convert non-sRGB ICC to sRGB when preparing textures (prepared textures currently drop ICC data).
- [ ] Batch alpha fixtures native device verification.
- [x] Persist GLB+USDZ derivatives and conversion provenance. *(asset_derivatives unique per source × type × settings hash × converter version; job input + diagnostics (ADR-023))*
- [ ] Optional: alpha contour/cutout geometry, behind feature gate.

## P3: Editor

- [ ] Dashboard and creation wizard.
- [ ] Placement mode selector and mode migration flow.
- [x] Scene graph, object tree and Three.js viewport. *(P3 M9, ADR-027: tree, viewport with canonical anchors, inspector, selection, show/hide, rename, remove; lost-update fix)*
- [x] Transform inspector with canonical coordinates and snapping. *(P3 M10, ADR-028: cm/°/% fields, gizmos with explicit tools, snapping, lock/duplicate/remove, put on floor/image, flush to wall, fit to image)*
- [ ] Multiple models, image objects, panels, text and primitives.
- [ ] Actions, primary CTA and page-link fallbacks.
- [-] Autosave, undo/redo, reusable asset library. *(autosave M4; undo/redo M10 (ADR-028); reusable asset library in the editor: M11)*
- [-] Platform capability preview. *(registry `packages/capabilities` done; UI pending)*

## P4: Runtimes

- [ ] Compile iOS image/floor/wall USDZ with validation (multi-node scenes).
- [-] Implement Android image WebXR viewer, capability detection and state lifecycle. *(runtime logic in `packages/webxr-image` done; public viewer UI in `apps/web` pending)*
- [ ] Compose hosted Scene Viewer GLB from all eligible scene nodes.
- [x] Generate separate Scene Viewer floor/wall intent params (`buildSceneViewerIntent`; device check pending).
- [ ] Validate Quick Look CTA and Scene Viewer link mappings on device.
- [ ] Public landing page, desktop 3D preview, supported fallbacks.

## P5: Publishing and QA

- [ ] Workflows/Queues job orchestration with idempotent steps.
- [ ] Immutable revisions and atomic publish promotion.
- [ ] Stable public URL, QR and share/download actions.
- [ ] Retry/error reporting and partial readiness.
- [ ] Full device matrix, accessibility, security and load checks.
- [ ] Documentation and changelog updated with verified evidence.

## Change handling

Do not check off anything from this backlog based on planning/specification alone. If requirements change, update the relevant spec and append an ADR before changing implementation.

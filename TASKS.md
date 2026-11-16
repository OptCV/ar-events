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
- [ ] P1-4 Experiences + draft API with ownership checks (cross-user → 404).
- [ ] P1-5 R2 uploads: pending asset, streamed upload, magic bytes, size/dimension limits, SHA-256, explicit roles, signed private reads.
- [ ] P1-6 Dashboard UI: login, experience list, create draft, upload with progress/errors.
- [x] Email verification + password reset flows (dev mailbox locally).
- [ ] Resend: API key secret, verified sending domain, `EMAIL_FROM`; then real-delivery test. Public sign-up stays off until done.
- [x] Implement scene schema / discriminated placement union (`packages/schema`, v1; migrations pending).
- [-] Add migration, lint, typecheck and automated test scripts. *(typecheck + Vitest + pytest + Playwright (Edge channel) done; ESLint/Prettier and DB migrations pending)*

## P2: Image-to-AR

- [-] Distinguish tracking image vs displayed image asset role. *(schema-level `AssetRole` + placement/node types done; storage/UI pending)*
- [ ] Create checkerboard/size/alpha options UI.
- [x] GLB image-plane generator with `MASK` / `BLEND` (structurally validated; device check pending).
- [x] USDZ image-plane generator with alpha/opacity material (structurally validated; device check pending).
- [ ] Normalize WebP and EXIF-rotated JPEG to PNG/JPEG before conversion (ADR-009).
- [ ] Texture size limits / downscaled derivative for native viewer budgets.
- [ ] Batch alpha fixtures native device verification.
- [ ] Persist GLB+USDZ derivatives and conversion provenance.
- [ ] Optional: alpha contour/cutout geometry, behind feature gate.

## P3: Editor

- [ ] Dashboard and creation wizard.
- [ ] Placement mode selector and mode migration flow.
- [ ] Scene graph, object tree and Three.js viewport.
- [ ] Transform inspector with canonical coordinates and snapping.
- [ ] Multiple models, image objects, panels, text and primitives.
- [ ] Actions, primary CTA and page-link fallbacks.
- [ ] Autosave, undo/redo, reusable asset library.
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

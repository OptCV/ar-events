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
- [ ] Owner decisions: managed Postgres provider/region; email provider; confirm Workers Paid plan; upload path.
- [ ] P1-1 `apps/web` (Vite + React + TS + CSS Modules) + `apps/api` (Hono) as one Worker via `@cloudflare/vite-plugin` (verify ADR-014).
- [ ] P1-2 `packages/db`: Drizzle schema (Better Auth tables + app tables), migrations, local Postgres in Docker; Hyperdrive binding.
- [ ] P1-3 Auth in `apps/api` from the spike; `requireSession`; mutation Origin guard; sign-up/in/out UI.
- [ ] P1-3 Edge verification on a Paid account: CPU per sign-in, Secure cookies, revocation with Hyperdrive caching disabled.
- [ ] P1-4 Experiences + draft API with ownership checks (cross-user → 404).
- [ ] P1-5 R2 uploads: pending asset, streamed upload, magic bytes, size/dimension limits, SHA-256, explicit roles, signed private reads.
- [ ] P1-6 Dashboard UI: login, experience list, create draft, upload with progress/errors.
- [ ] Email verification + password reset (blocked on email provider).
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

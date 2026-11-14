# CHANGELOG.md

This changelog records actual specification and implementation changes. Do not claim features are shipped because they are listed in a prompt.

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

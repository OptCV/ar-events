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

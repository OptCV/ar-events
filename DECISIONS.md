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

# TESTING.md — Verification Protocol and Evidence

## Levels of confidence

- **Specified:** documented but no code.
- **Implemented:** source and tests exist; tests may be limited.
- **Structurally validated:** file parses/validates, but native viewer not tested.
- **Device verified:** target device + OS + browser/viewer version recorded with visible result.

**Current baseline (2026-11-14):** schema, launch URLs, capability registry and flat Image-to-AR GLB/USDZ conversion are **Implemented + structurally validated**. Every device row below is **NOT TESTED**.

## Automated evidence log

| Date | Command | Scope | Result |
|---|---|---|---|
| 2026-11-14 | `npm run typecheck` | all TS packages + scripts | pass |
| 2026-11-14 | `npm test` | schema (10), platform-launch (14), capabilities (5), image-to-ar (41) | 70/70 pass |
| 2026-11-14 | `npm run usd:test` | USDZ image plane: 7 display fixtures × 4 anchors, alpha wiring, golden geometry, anchoring metadata, determinism, bad inputs, validator negatives | 54/54 pass |
| 2026-11-14 | `npm run p0:build` | 7 P0 GLB/USDZ pairs | 0 validation errors/warnings |
| 2026-11-14 | `npm test` | + webxr-image (16): adapter shapes, preflight timeout, state machine, anchor tracker | 86/86 pass |
| 2026-11-14 | `npm run usd:test` | + cross-time reproducibility (ADR-011) | 55/55 pass |
| 2026-11-14 | `npm run test:e2e` (Playwright 1.64.1, Edge channel, desktop) | device-lab links per runtime; WebXR probe unsupported path, CSP, GLB load, no console errors | 2/2 pass |
| 2026-11-14 | `npm run p0:build` ×2, 3 s apart | USDZ reproducibility | identical hashes |

Validators: GLB — Khronos `gltf-validator` 2.0.0-dev.3.10 (0 errors and 0 warnings required). USDZ — OpenUSD 26.8 `UsdValidation` (28 validators) + Quick Look profile checks (ADR-008). Neither is evidence of on-device behavior.

## Converter resource baseline (local Docker, not Cloudflare)

2026-11-14, x86-64 Docker Desktop: image 453 MB; Python import 0.16 s; convert + validate a 1200×800 PNG image-anchored USDZ 0.04 s; peak RSS 117 MB under `--memory 256m`. Flat image conversion appears well within small container sizes; model conversion (glTF→USD, Blender) is not yet measured.

## P0 device kit

`P0_BASE_URL=https://<host> npm run p0:build` writes `out/p0/` (GLB, USDZ, images, `manifest.json` with SHA-256, `index.html` with launch links, `_headers`). Host it over HTTPS (`infra/p0-lab/wrangler.jsonc`). Case → matrix mapping:

| P0 case | Matrix rows | What it proves |
|---|---|---|
| `img-overlay` | IOS-IMG-01, AND-IMG-01 | 20 cm probe card must exactly cover the printed 20 cm target: physicalWidth cm conversion + image-frame axes (ADR-005 H3) |
| `floor-probe` | IOS-FLR-01, AND-FLR-01 | horizontal placement, bottom pivot on floor, arrow up |
| `wall-probe` | IOS-WAL-01, AND-WAL-01 | vertical placement and wall axis hypotheses H1/H2 |
| `alpha-steps`, `alpha-hole`, `alpha-fringe` | IOS-ALPHA-01, AND-ALPHA-01 | BLEND levels, MASK hole, dark-halo trap |
| `link-cta` | AND-LINK-01, IOS-LINK-01 | Scene Viewer `link`, Quick Look banner tap → page handler |

Record the asset SHA-256 from `manifest.json` with each result.

### AND-IMG protocol (WebXR probe, `out/p0/webxr/`)

1. ARCore-supported Android phone, Chrome (record version from `chrome://version`), Google Play Services for AR version.
2. **AND-IMG-02 (flag off, default):** open the probe, tap Start AR. Expected: report `outcome: "image-tracking-unavailable"`, `unavailableReason: "feature-not-granted"`, and the fallback message. This is what most real visitors will see.
3. **AND-IMG-01 (flag on):** enable `chrome://flags` → "WebXR Incubations", relaunch, print the target at exactly 20.0 cm wide, tap Start AR and point at the print. Expected: status goes scanning → tracked; the card covers the print exactly; red top-left corner and arrow toward the top of the print; axis helper red → image right, green → out of the print, blue → image bottom (H3); `measuredWidth.ratioToRegistered` ≈ 1; "Overlay CTA" tap recorded (`overlayCtaTapped: true`), which verifies the DOM overlay.
4. Move the print out of view and back: expect lost → tracked transitions.
5. Paste the probe's JSON report (contains UA, enabled features, scores, transitions, measured width, GLB SHA-256; no imagery) into the Evidence column.

Local alternative to hosting: `npm run p0:build && npm run p0:webxr:dev`, `adb reverse tcp:5173 tcp:5173`, open `http://localhost:5173` on the phone (localhost is a secure context).

## Automated testing

### Schema and scene model
- Roundtrip `image`, `floor`, and `wall` placement unions.
- Reject image mode without target and physical width; floor/wall do not require target.
- Verify transform units, normalized quaternions and axis conversion tests.
- Reject malformed action URLs; disallow `javascript:` and hostile protocols.
- Stable IDs, ordered scene traversal, missing asset and cyclic parent validation.

### Image-to-AR conversion
- Fixtures: opaque JPG, PNG with transparent border, inner-hole PNG, semitransparent PNG, alpha-edge image, tall and wide variants.
- GLB: check dimensions, number of triangles/UVs, embedded texture, `alphaMode`/cutoff/double-sided, render screenshot on checkerboard.
- USDZ: check package, referenced texture, `UsdPreviewSurface` opacity connection, orientation, dimensions, and USD checker output.
- Assert converter reproducibility for same input/settings, hashes, idempotency and failure cleanup.
- Validate flat alpha plane vs optional geometrically cut-out mesh semantics.

### Scene packaging
- Compose multiple models/images/text/panels into one hosted Scene Viewer GLB.
- Ensure local `blob:` URLs are not passed to native Android viewer.
- Verify first-animation/Scene Viewer compatibility warnings.
- Apple image reference and physical width conversion **meters to centimeters**.
- Apple floor and wall plane alignment.
- Ensure no missing USDZ/GLB textures or external unresolved dependencies.

### API and publication
- Unauthorized user cannot read/edit private drafts/assets.
- R2 upload validation for MIME/magic bytes, size, checksum, signed completion and expiration.
- Publish workflow with retries, failed conversion, partial readiness, duplicate idempotency key, superseded revision and last-good preservation.
- Immutable asset URL identity, cache headers, full scene manifest integrity.
- Public page has only approved published links and metadata.

### Browser and UI
- Creator flow autosave, route mode switching, scene editing and undo/redo.
- Explicit primary CTA fallback in each runtime.
- Image target and display image roles are visually distinguishable.
- Accessibility: labels, focus, keyboard, color contrast and reduced motion.

## Physical-device matrix (fill after execution)

| ID | Device/OS | Browser/viewer | Scenario | Expected | Result | Evidence |
|---|---|---|---|---|---|---|
| IOS-IMG-01 | TBD | Safari + Quick Look | recognize 20cm image | USDZ scene anchored | NOT TESTED | — |
| IOS-FLR-01 | TBD | Safari + Quick Look | horizontal place | horizontal anchor | NOT TESTED | — |
| IOS-WAL-01 | TBD | Safari + Quick Look | vertical place | vertical anchor | NOT TESTED | — |
| IOS-ALPHA-01 | TBD | Quick Look | alpha 0/0.5/1 PNG | no opaque background | NOT TESTED | — |
| AND-IMG-01 | TBD | Chrome WebXR experimental (flag on) | image tracking | real tracked pose, H3 axes, width ratio ≈ 1, overlay CTA | NOT TESTED | — |
| AND-IMG-02 | TBD | Chrome default (flag off) | image tracking unavailable | honest fallback, `feature-not-granted` | NOT TESTED | — |
| AND-FLR-01 | TBD | Scene Viewer | horizontal model | native Scene Viewer AR | NOT TESTED | — |
| AND-WAL-01 | TBD | Scene Viewer | vertical option | wall placement | NOT TESTED | — |
| AND-ALPHA-01 | TBD | Scene Viewer | transparent GLB | see-through pixels | NOT TESTED | — |
| AND-LINK-01 | TBD | Scene Viewer | `link` parameter | native CTA | NOT TESTED | — |
| IOS-LINK-01 | TBD | Safari + Quick Look | `callToAction` banner | banner tap posts message; page opens link | NOT TESTED | — |

## Recording protocol

For each device test capture date, tester, device model, OS, Chrome/Safari version, Google app/AR services version when applicable, generated asset checksum, target image print width, expected vs actual, video/screenshot location if lawful, and reproducible steps. Report failures with minimal fixtures. Never mark device verified from only `usdchecker` or web preview.

## Release gates

1. Format and schema checks pass.
2. Image-to-AR alpha fixtures pass conversion checks.
3. Both native viewers visually accept example transparent assets.
4. Android floor/wall use Scene Viewer with real device result; image uses WebXR native tracking where enabled.
5. iOS all anchor types verified on supported device.
6. Publication rollback and failed revision tests pass.
7. Security and accessibility blockers resolved.

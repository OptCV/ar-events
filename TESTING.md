# TESTING.md — Verification Protocol and Evidence

## Levels of confidence

- **Specified:** documented but no code.
- **Implemented:** source and tests exist; tests may be limited.
- **Structurally validated:** file parses/validates, but native viewer not tested.
- **Device verified:** target device + OS + browser/viewer version recorded with visible result.

**Current baseline (2026-11-14):** schema, launch URLs, capability registry and flat Image-to-AR GLB/USDZ conversion are **Implemented + structurally validated**. Remote **Neon/Hyperdrive/Cloudflare authentication is NOT VERIFIED** (no remote test has run). Device rows are **NOT TESTED** except AND-IMG-01, which is **PARTIAL** (runtime path verified on one Android/Chrome 157 device; visual/geometry checks outstanding).

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
| 2026-11-14 | `npm run check:all` | + device-report regressions (width echo, reduced UA, client hints, frame counts) | Vitest 91/91, pytest 55/55 |
| 2026-11-14 | `npm run test:e2e` | + probe 0.2.0 observations form and device info | 2/2 pass |
| 2026-11-14 | `spikes/auth-workers: npm run verify` (wrangler 4.156.0 / local workerd, Postgres 17 in Docker) | Better Auth 1.7.14 + Hono + Drizzle + pg via Hyperdrive local binding: migrate, sign-up, duplicate, wrong password, sign-in cookie flags, protected route, 12 concurrent requests, hash at rest, sign-out revocation, per-IP DB rate limit, no runtime errors | 16/16 pass (local only — edge NOT VERIFIED) |
| 2026-11-14 | `npm run check:all` (P1 M1) | typecheck (root + Worker + SPA configs), Vitest 6 files incl. `apps/api` (5 tests: health contract, headers, 404/500 error contract without leaks, non-API paths), pytest | Vitest 96/96, pytest 55/55 |
| 2026-11-14 | `npm run test:e2e` (P1 M1) | `app-preview` (production build via `vite preview`, workerd) + `app-dev` (`vite dev`, workerd): home + live health, `/api/health` contract/headers/`runtime: workerd`, `/api/*` 404 is JSON (not SPA), deep-link SPA fallback, skip link + focus; prod-only: CSP/frame/nosniff headers, immutable assets, no public client source maps; plus `p0` | 13/13 pass |
| 2026-11-14 | `npm run build` (P1 M1) | Worker 227.5 KB (54.7 KB gzip), client JS 432.9 KB (133.1 KB gzip), CSS 4.1 KB | builds; not deployed |
| 2026-11-14 | `npm run test:db` (P1 M2; Docker PostgreSQL 17, fresh database per test file) | migrations: empty DB reports `behind`, applies cleanly, idempotent, triggers installed, **no schema drift** (mutation-checked), enums equal TS sources; integrity: slugs/names, owner FK, one draft per experience, composite FK (pointers stay within an experience), published revision undeletable, user/experience cascades, frozen-revision immutability, frozen_at rule, JSON object config, asset/derivative/output/job CHECKs + uniques + ready-immutability; connection: per-request connect/close, wrong password → `auth` (no secrets in error), unreachable → `unreachable` < 5 s, missing DB → `misconfigured`, empty string → `not_configured`, `statement_timeout` → `timeout`, dead connection health, redaction | 28/28 pass |
| 2026-11-14 | `npm test` (P1 M2) | + API health with injected DB: healthy, one connection per request and closed, lazy connect, migrations behind → 503, auth/not_configured/unreachable → 503 with safe category and redacted logs, query timeout, DB errors → 503 `unavailable` vs other coded errors → 500 | Vitest 104/104 |
| 2026-11-14 | `npm run test:e2e` (P1 M2) | + `app-dev`/`app-preview` (workerd → Hyperdrive local binding → Docker Postgres): health `database: ok, migrations: current`, UI shows Connected, no password or credentialed URL in any browser-visible response or **any file in the production build** (detection proven with a planted password), deployable config contains only the Hyperdrive ID; + `app-db-down` (closed port, fake password): 503 `degraded`, safe category, no host/password/driver text, UI shows Degraded | 22/22 pass |
| 2026-11-14 | manual: 30 concurrent `/api/health` against `vite dev`, then `pg_stat_activity` | per-request connections are closed | 30× 200, 0 open `ar-creator` connections |
| 2026-11-14 | `npm run test:integration` (P1 M3; full Hono app + Better Auth 1.7.16 + Docker Postgres) | config (sign-up open/closed, prod without email keeps sign-up closed, missing secret → 503, endpoint allowlist); registration (unverified account, no session, own-origin link; invalid input; duplicate rejected without enumeration; unverified sign-in → 403 + resend; verification link + tampered token); sessions (HttpOnly/SameSite=Lax cookie, token stripped from body, identical 401 for wrong password vs unknown email, persistence + DB row, `/api/session`, expiry, sign-out revocation with cookie replay, revoke-all, production `__Secure-` + Secure); unauthorized access (no/forged/malformed cookie → 401, **login-CSRF regression**, dev mailbox 404 outside dev); password reset (full flow, sessions revoked, old password rejected, token single-use, no enumeration, **token-leak and open-redirect regressions**); rate limits (sign-in 5/min → 429 + Retry-After, other IPs unaffected, DB rows; reset requests 3/15 min); DB failures (503 without internals; auth-config still served) | 30/30 pass |
| 2026-11-14 | `npm test` (P1 M3) | + config fail-closed rules, redirect validator, endpoint allowlist, Resend client (headers, idempotency, key never in errors), template escaping/own-origin | Vitest 124/124 |
| 2026-11-14 | `npm run test:db` (P1 M3) | + Neon role model rehearsal with real roles: `ar_migrator` owns all objects, `ar_app` cannot migrate, grants idempotent, runtime suite (marker, no DDL rights, migrations current, DDL denied, session queries, triggers, no residue) | 38/38 pass |
| 2026-11-14 | `npm run test:e2e` (P1 M3) | + auth flows in workerd (dev and production build): sign-up → dev-mailbox verification → sign-in → `/account`, cookie HttpOnly/Lax and invisible to `document.cookie`, reload persistence, sign-out + server-side revocation (cookie replay 401), protected-route redirect with return path, validation/wrong-password/unverified states, client password policy, forgot/reset flow, invalid reset link page, unauthorized/CSRF/allowlist API checks | 36/36 pass |
| 2026-11-14 | manual `db:remote` rehearsal against a local scratch database | status; refusals: owner role, production without `--approved`, marker mismatch, wrong confirmation, pooler host, missing sslmode; migrate as `ar_migrator`; verify as `ar_app` (7/8: TLS check fails locally as expected) | as expected |
| 2026-11-14 | `spikes/auth-workers: node bench-hash.mjs` | Better Auth default scrypt (native node:crypto, N=16384 r=16 p=1) | hash ≈ 37 ms, verify ≈ 37 ms (local CPU; exceeds the 10 ms Free-plan CPU limit) |

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
3. **AND-IMG-01 (flag on):** enable `chrome://flags` → "WebXR Incubations", relaunch, print the target and **measure it with a ruler** (enter the width in the probe), tap Start AR and point at the print. Expected: status goes scanning → tracked; the card covers the print exactly; red top-left corner and arrow toward the top of the print; axis helper red → image right, green → out of the print, blue → image bottom (H3); "Overlay CTA" tap recorded (`overlayCtaTapped: true`), which verifies the DOM overlay. **Do not use `measuredWidth` as size evidence:** on Chrome 157 it echoes the registered width (`echoesRegistered: true`); physical size is judged only by the card covering the ruler-checked print.
   Fill in every "Tester observations" field before copying the report (probe ≥ 0.2.0).
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
| AND-IMG-01 | Android device — model and OS version **not recorded** (reduced UA "Android 10; K") | Chrome 157 (major only; flag state not recorded) | image tracking | tracked pose, card covers print, H3 axes, re-acquire, overlay CTA | **PARTIAL** — runtime path verified; visual/geometry items NOT VERIFIED (see AND-IMG-01 result below) | probe 0.1.0 report, 2026-11-14T18:38:12Z, GLB `2b1167ae…5f36` |
| AND-IMG-02 | TBD | Chrome default (flag off) | image tracking unavailable | honest fallback, `feature-not-granted` | NOT TESTED | — |
| AND-FLR-01 | TBD | Scene Viewer | horizontal model | native Scene Viewer AR | NOT TESTED | — |
| AND-WAL-01 | TBD | Scene Viewer | vertical option | wall placement | NOT TESTED | — |
| AND-ALPHA-01 | TBD | Scene Viewer | transparent GLB | see-through pixels | NOT TESTED | — |
| AND-LINK-01 | TBD | Scene Viewer | `link` parameter | native CTA | NOT TESTED | — |
| IOS-LINK-01 | TBD | Safari + Quick Look | `callToAction` banner | banner tap posts message; page opens link | NOT TESTED | — |

## Device results

### AND-IMG-01 — 2026-11-14 (probe 0.1.0) — PARTIAL

Device: Android phone, Chrome 157; exact model, Android version, full Chrome version and flag state were **not captured** (reduced UA; probe 0.1.0 had no client hints). Asset: `img-overlay.glb` SHA-256 `2b1167aebb509bd72e06ea0e9abbd3f51ddc4904c8ac7858f1ef2da061e55f36` (matches current build). Target registered at 0.20 m.

| Item | Evidence in report | Status |
|---|---|---|
| HTTPS + `immersive-ar` supported | `preflight` all true | **Device verified** |
| Native `image-tracking` granted, API shape = Chrome `trackedImages`/`getTrackedImageScores`/`getImageTrackingResults` | `enabledFeatures` incl. `image-tracking`; `api: chrome-image-tracking` | **Device verified** (validates ADR-010 adapter) |
| Target image rated trackable | `scores: ["trackable"]` | **Device verified** for `tracking_target_20cm.png` |
| Pose acquired | `scanning → tracked` at frame 202 / 6.9 s (includes aiming time) | **Device verified** |
| DOM overlay shown and tappable during AR | `domOverlayType: "screen"`, `overlayCtaTapped: true` | **Device verified** |
| Physical size (card = 20 cm print) | `measuredWidth` = registered value on all 478 samples → UA echo, not a measurement | **NOT VERIFIED** — needs tester observation |
| Card alignment / orientation / H3 axes | not observable by the page | **NOT VERIFIED** |
| `emulated` / `lost` / re-acquire | no transitions after `tracked`; unknown whether the print left view | **NOT VERIFIED** |
| Pose stability / drift | not recorded | **NOT VERIFIED** |
| Flag-off fallback (AND-IMG-02) | not run | **NOT TESTED** |

Probe defects found from this report and fixed in probe 0.2.0 (ADR-012): width echo flagged (`echoesRegistered`, `usableAsSizeEvidence`), device model/OS/full versions via UA Client Hints, tester-observation fields, raw frame counts, duration and end reason. **Re-run AND-IMG-01 with probe 0.2.0** and run AND-IMG-02 to complete the row.

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

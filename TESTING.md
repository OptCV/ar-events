# TESTING.md — Verification Protocol and Evidence

## Levels of confidence

- **Specified:** documented but no code.
- **Implemented:** source and tests exist; tests may be limited.
- **Structurally validated:** file parses/validates, but native viewer not tested.
- **Device verified:** target device + OS + browser/viewer version recorded with visible result.

**Current baseline (2026-11-14):** schema, launch URLs, capability registry and flat Image-to-AR GLB/USDZ conversion are **Implemented + structurally validated**. **Neon development database: VERIFIED 2026-11-15** (migrations applied as `ar_migrator`, runtime-role suite 8/8 as `ar_app`; see "Remote results"). **Cloudflare authentication: VERIFIED 2026-11-15 on the isolated dev Worker** (REMOTE-AUTH-01, 9/9; email flows pending Resend). **Experiences + R2 asset storage: VERIFIED 2026-11-22 on the isolated dev Worker** (REMOTE-CONTENT-01, 8/8, with the auth suite re-run 9/9). Device rows are **NOT TESTED** except AND-IMG-01, which is **PARTIAL** (runtime path verified on one Android/Chrome 157 device; visual/geometry checks outstanding).

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
| 2026-11-15 | `npm test` (P1 M4) | + draft vs publishable scene, placement-change plans (nodes kept, removals listed, copy), publish readiness | Vitest 134/134 |
| 2026-11-15 | `npm run test:db` (P1 M4) | migrations incl. `0002_draft_version`, no drift, role model | 43/43 |
| 2026-11-15 | `npm run test:integration` (P1 M4) | + experiences: 401 on every route without a session; CSRF incl. DELETE (Origin-only); create per mode with draft revision 1 and slug; input validation with field issues; list isolation and ordering; PATCH (public refused); DELETE cascade; malformed ids 404; **cross-user 404 on GET/PATCH/PUT/validate/DELETE with data unchanged**; draft save and version bump; invalid scenes 400 (hostile URL, cycle, unknown primary, schema version); stale version 409 with current version; **4 concurrent saves → exactly one 200**; placement change needs confirmation, keeps nodes, updates listed mode; 413 over 256 KB; readiness reports | 48/48 (30 auth + 18 experiences) |
| 2026-11-15 | `npm run test:e2e` (P1 M4) | + dashboard empty → create (wall) → rename → list + search → delete; placement review dialog (cancel, Escape, confirm) and printed-width validation + autosave + reload persistence; **two-tab conflict → "Load the latest version"**; another user's URL shows "Experience not found" and API 404; protected routes redirect | 46/46 (all projects) |
| 2026-11-22 | `npm test` (P1 M5) | + asset inspection: real type vs declared type (spoofed SVG/HTML refused), PNG/JPEG metadata, decompression-bomb dimensions, tracking-image minimum and warnings, corrupt headers; GLB: self-contained files and data: URIs accepted, remote/relative/`file:`/protocol-relative refs refused, truncation, version, bad JSON, missing BIN chunk, extension warnings; PNG end marker; streaming pipeline (pass-through + SHA-256, declared checksum, head rejection stores nothing, longer/shorter than declared, truncated tail, files beyond the head window); signed URLs (expiry, tampering, other asset, replaced content, other secret, malformed, lifetime cap); filename sanitising (paths, bidi overrides, controls) and key safety | Vitest 155/155 |
| 2026-11-22 | `npm run test:db` (P1 M5) | migrations incl. `0003_asset_uploads`, no drift; pending needs expiry, rejected needs a code | 44/44 |
| 2026-11-22 | `npm run test:integration` (P1 M5) | + assets (Hono app + Docker Postgres + in-memory store): 401 on every session route; CSRF (cross-origin and Origin-less PUT refused without consuming the slot; non-JSON refused elsewhere); upload → validated with generated key, sanitised name, checksum, metadata; **signed read without cookies** (bytes, type, nosniff, private cache, CSP); JPEG and GLB; reservation validation (role, WebP, SVG, wrong type for role, empty, too large, bad checksum); rejections recorded with **nothing stored** and single-use slots (spoofed type, declared/actual type, length, checksum, missing Content-Length → 411, bomb dimensions, truncated PNG, GLB external URI); expired slot 409; **two concurrent PUTs → one 200, one 409**; **cross-user 404**, slot stays usable; signed URL missing/tampered/expired/other asset/deleted; pending-slot cap 429; quota 409; draft references (role, foreign asset, non-uuid, model nodes); delete blocked while referenced (409 naming the experience), then object and row removed | 71/71 (30 auth + 18 experiences + 17 assets + 6 workerd) |
| 2026-11-22 | `apps/api/test/assets.workerd.test.ts` (real `r2Store` + pipeline bundled with esbuild, run in workerd via Miniflare 5 and its R2 simulator) | streamed PUT stores the exact bytes; native `DigestStream` SHA-256 matches; 3 MB GLB beyond the head window; **nothing stored** on head rejection, truncated tail or checksum mismatch; R2 refuses a body that does not match the declared checksum; a failed overwrite leaves the existing object intact | 6/6 (local simulator, **not production R2**) |
| 2026-11-22 | `npm run test:e2e` (P1 M5) | + library: upload tracking/display/model with progress, metadata, **previews load through signed URLs from local R2**, usage, filter, delete; errors: WebP and oversize (client), renamed HTML (server signature), too-small tracking image; image experience: upload tracking image → printed size 20 × 13.3 cm → readiness clears → width change → reload persistence → delete blocked while in use → remove → delete; signed URL works in a cookieless context, tampered → 403, another user sees nothing and gets 404; desktop and phone screenshots reviewed (fixed: filter label "3D model (GLB)s", button text alignment, "1024 MB" → "1 GB") | 54/54 (all projects) |
| 2026-11-22 | `npm test` (P2 M1) | + `scanPngAlpha` (streaming, one scanline at a time) equals a full pngjs decode on every committed PNG fixture; all colour types × bit depths 1–16, palette/tRNS, grey/RGB tRNS, every filter type, Adam7 incl. images smaller than the first pass; refuses data larger than the header allows, truncation, missing IEND, corrupt deflate, non-PNG; 2048² in < 3 s (a mutation of the Paeth filter makes 5 fixture tests fail); `jpegOrientation` (both byte orders); conversions: Worker/Python converter version equality, canonical settings hashing, derivative key safety, signature kinds (derivative ≠ asset), converter client (frames, 4xx → not retried, 5xx/network/wrong type → retried) | Vitest 207/207 |
| 2026-11-22 | `npm run usd:test` (P2 M1) | + HTTP converter (`server.py`, real server on loopback inside the sandbox): health; PNG → framed USDZ (validates, texture byte-identical, no temp paths in output); byte-reproducible; bad/duplicate/unknown parameters 400; JPEG+BLEND, width out of range, non-image, checksum mismatch → 422; empty 400, oversize 413; unknown routes 404 | 68/68 |
| 2026-11-22 | `npm run test:db` (P2 M1) | migrations incl. `0004_image_to_ar_jobs`, no drift; ready derivative needs a size; derivative checksum format and owned key prefix; failed job needs an error code | 46/46 |
| 2026-11-22 | `npm run test:integration` (P2 M1, needs `npm run usd:serve`) | + conversions with the **real converter image** over HTTP (Hono app + Docker Postgres + in-memory store, inline runner = the Workflow's step functions): 401/404 access rules, cross-user 404, CSRF; **every display fixture** → auto alpha as in the manifest, GLB/USDZ dimensions equal `physicalSize`, cookieless signed reads with correct MIME, GLB embeds the original bytes, USDZ stored + 64-byte aligned with `scene.usdc` first and the original texture bytes; same settings → same job, no new work; outputs count toward usage; not-convertible roles/states 409; invalid settings 400; OPAQUE on transparency → `invalid_settings`, nothing written; EXIF-rotated JPEG → `unsupported_image`; converter outage → `converter_unavailable`, restart = attempt 2 reusing the finished GLB; 3-attempt cap; 3 active conversions → 429; delete while converting → 409; signature kind/id binding; deleting the source removes both derivative objects and rows | 92/92 (+21 conversions) |
| 2026-11-22 | `npm run test:e2e` (P2 M1) | + image to AR in workerd with the **real local Workflow engine** and the Docker converter (dev server and production build): library → "Make AR object" → preview backgrounds → width in cm/in with derived height and validation → convert → "ready" → USDZ download (PK) and GLB (glTF, `model/gltf-binary`, cookieless) → second version (Blend, both sides) → earlier versions → same settings reused → delete source; refusals: Opaque on a transparent PNG explained, tracking images have no AR-object action; desktop and phone screenshots reviewed | 58/58 (all projects) |
| 2026-11-22 | `npm run test:integration` (P2 M7) | + `GET /api/image-objects`: complete pairs only (failed conversions excluded), signed source preview, newest first, 401 without a session, owner-only; drafts: a USDZ id, an unknown id, an asset id and another user's GLB are refused (400), the owner's GLB id is saved; deleting the source while placed → 409 naming the experience; after removing the node → 204 | 94/94 (+2) |
| 2026-11-22 | `npm run test:e2e` (P2 M7) | + soft-edge highlight: hard cutout → "No partly transparent pixels", antialiased disc → share in %; result 3D preview reaches `ready` in headless Edge (WebGL), drag-orbit; place the image object in a wall experience → saved → survives reload → source delete blocked ("used by “Gallery wall”") → remove; three.js only in the lazy `ModelPreview` chunk; desktop and phone screenshots reviewed (fixed: secondary buttons rendered as primary, empty lazy thumbnails) | 60/60 (all projects) |
| 2026-11-22 | `npm run deploy:dev -- --subdomain quiet-dawn-af59 --dry-run` (P2 M1) | builds the Container image from the `runtime` stage; bindings `USD_CONVERTER` (Container DO), `IMAGE_TO_AR` (`ar-creator-dev-image-to-ar`), dev Hyperdrive, dev bucket; new guard refuses any other Workflow or > 3 instances; nothing uploaded | pass |
| 2026-11-14 | `spikes/auth-workers: node bench-hash.mjs` | Better Auth default scrypt (native node:crypto, N=16384 r=16 p=1) | hash ≈ 37 ms, verify ≈ 37 ms (local CPU; exceeds the 10 ms Free-plan CPU limit) |

Validators: GLB — Khronos `gltf-validator` 2.0.0-dev.3.10 (0 errors and 0 warnings required). USDZ — OpenUSD 26.8 `UsdValidation` (28 validators) + Quick Look profile checks (ADR-008). Neither is evidence of on-device behavior.

**First Container deploy (2026-11-22): BLOCKED, then resolved the same day** (Workers Paid; REMOTE-CONVERT-01 PASS). Original note: Cloudflare refused the container step with 401 ("Deploying containers requires the Workers Paid plan"); REMOTE-CONVERT has not run. `deploy:dev` now checks Containers access before uploading (refusal path verified; nothing uploaded).

**Local conversion timing (P2 M1, dev server, warm Docker converter):** a 256 × 512 PNG converts end to end (queue → GLB → USDZ → stored) in ≈ 0.6 s. Cloudflare Container cold starts are not measured yet.

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

## Remote results

### NEON-DEV-01 — Neon development branch — 2026-11-15 — PASS

Target: endpoint `ep-weathered-resonance-bce5rdkp` (development, child of production), database `neondb`, AWS us-east-1, marker `ar.environment=development` (database comment). Commands were run by the owner in PowerShell; secrets were entered at hidden prompts only.

| Step | Command / action | Result |
|---|---|---|
| Roles | `db:remote create-roles --env development` (after deleting Console-created roles that had `neon_superuser`) | `ar_migrator`, `ar_app`: superuser/createdb/createrole/bypassrls all false, no memberships |
| Owner grants | SQL Editor (plain GRANT statements) + check query | migrator can create schema/tables; app cannot create tables |
| Marker | `COMMENT ON DATABASE` (ALTER DATABASE SET → 42501 on Neon) | comment verified |
| Preflight | `db:remote status --env development --host …` as `ar_migrator` | TLSv1.3 verified, 0/2 applied |
| Migrate (approved) | `db:remote migrate --env development --host …` | 2/2 applied + runtime grants |
| Verify | `db:remote verify --env development --host …` as `ar_app` | **8/8 pass**: marker, non-superuser without DDL, TLS verified (client side), migrations current, DDL denied, session create/lookup/expire/revoke (rolled back), triggers fire (rolled back), no residue |

Findings fixed during setup (tooling, not schema): `pg_stat_ssl` reports `false` behind Neon's proxy, so TLS is now checked client-side; the marker moved to a database comment; `--host` mode builds and URL-encodes the connection string so only the password is entered.

### REMOTE-AUTH-01 — Cloudflare edge, isolated dev Worker — 2026-11-15 — PASS (9/9)

Target: Worker `ar-creator-dev` (`https://ar-creator-dev.quiet-dawn-af59.workers.dev`, version `c72c7702-7b21-4230-8b2a-bbce613461a1`, build `2bdf4e9c583e-dirty`) → Hyperdrive `ar-creator-db-dev`/`f7b30d81…` (caching disabled, role `ar_app`) → Neon development. Run by the owner: `npm run db:remote -- remote-auth-test --env development --host … --base-url …`; temporary verified user seeded as `ar_app` and removed afterwards.

| Check | Result |
|---|---|
| Fail-closed before the secret was set | `/api/auth/*` and `/api/session` → 503; health/auth-config 200 |
| REMOTE-HEALTH | workerd; database ok through Hyperdrive (~108–575 ms request), migrations current |
| REMOTE-STATIC | SPA over HTTPS with CSP / frame-ancestors headers |
| REMOTE-SIGNUP-CLOSED | `signupEnabled: false`; sign-up 403 |
| REMOTE-SIGNIN | wrong password 401; correct password → `__Secure-arc.session_token` with Secure, HttpOnly, SameSite=Lax; token not in body; `/api/me` + `/api/session` OK; **sign-out revocation immediate through Hyperdrive** (cookie replay 401) |
| REMOTE-REVOKE-ALL | other device's session 401 after revoke-sessions |
| REMOTE-BROWSER | real Edge browser: protected redirect → sign-in → `/account`; cookie secure/httpOnly/Lax and invisible to `document.cookie`; sign-out |
| REMOTE-GUARDS | cross-origin sign-in 403; non-allowlisted endpoint 404; foreign `redirectTo` 400; unauthenticated `/api/me` 401 |
| REMOTE-CF-IP | a client-supplied `CF-Connecting-IP` is rejected **by Cloudflare's edge** (403 `error code: 1000`, `Server: cloudflare`, not JSON) before the Worker runs, so the rate-limit key cannot be spoofed |
| REMOTE-RATE-LIMIT | wrong passwords from the real IP → 429 at the edge; the correct password is also refused while limited, with Retry-After |

First run: 7/8. The CF-IP assertion expected 429; diagnosis showed Cloudflare blocks the spoofed header outright (a stronger property), so the test was corrected and the rate-limit check split out. Second run: 9/9.

**Not yet verified remotely:** email verification and password reset (need Resend: API key, verified domain, `EMAIL_FROM`); sign-in CPU time (read it in the dashboard: Workers & Pages → `ar-creator-dev` → Observability / Metrics → CPU time); production (`ar-creator` Worker, production Neon) is untouched.

### REMOTE-CONTENT-01 — Cloudflare edge, isolated dev Worker + R2 — 2026-11-22 — PASS (8/8; full remote run 17/17 in 1.3 min)

Target: Worker `ar-creator-dev` (version `aec8691a-6a47-4406-90e4-1d76d119868a`, build `a162f66e7ea2`) → Hyperdrive `ar-creator-db-dev` (caching disabled, `ar_app`) → Neon development endpoint `ep-dark-butterfly-bctzb64e` (marker `development`, TLSv1.3 verified, migrations 4/4), and → R2 bucket `ar-creator-assets-dev`. Owner set-up (bucket, migrations 0002 + 0003, redeploy) on 2026-11-22. Run by the owner in PowerShell: `npm run db:remote -- remote-auth-test --env development --host ep-dark-butterfly-bctzb64e.c-16.us-east-1.aws.neon.tech --base-url https://ar-creator-dev.quiet-dawn-af59.workers.dev`; temporary user seeded as `ar_app` and removed afterwards (1 user). The spec was first dry-run against the local workerd build (8/8) to check the test code itself.

| Check | Result |
|---|---|
| REMOTE-AUTH-01 re-run (auth.remote.spec.ts) | 9/9 on the M5 build |
| REMOTE-CONTENT-SIGNIN | one session after the auth suite's rate limit window (~1 min wait); empty library, 0 of 1 GB used |
| REMOTE-UPLOAD | tracking PNG reserved → streamed through the Worker → **real R2**; validated with SHA-256 and 1200 × 800; cookieless signed read returns identical bytes with `image/png`, `private, max-age`, `nosniff`; tampered, missing and stale signatures 403; unknown id 404; slot reuse 409 `upload_not_pending` |
| REMOTE-UPLOAD-LARGE | 10.3 MiB incompressible PNG (display image) uploaded, hashed and stored, read back identical; ~2 s for the test, no Workers CPU or size limit hit |
| REMOTE-UPLOAD-GLB | self-contained GLB accepted, glTF 2.0, 1 mesh |
| REMOTE-REJECT | HTML disguised as PNG → 422 `signature_mismatch`, row `rejected`, no read URL; wrong client checksum → 422 `checksum_mismatch`; cross-origin binary PUT → 403 |
| REMOTE-EXPERIENCE | image-anchored experience created; display image as tracking target → 400; tracking image saved; stale `draftVersion` → 409; deleting an in-use asset → 409 `asset_in_use` |
| REMOTE-BROWSER-LIBRARY | real Edge browser over HTTPS: `/library` shows the asset; both image previews load from signed URLs under the production CSP |
| REMOTE-CLEANUP | experience and every uploaded asset deleted (204); the earlier signed URL → 404; list empty, usage 0 |

Bucket privacy (read-only `wrangler r2 bucket dev-url get` / `domain list`, 2026-11-22): `ar-creator-assets-dev` and `ar-creator-assets` both have r2.dev public access **disabled** and **no custom domains**; objects are reachable only through the Worker binding.

**Not captured:** the per-test annotations (upload time, the edge's answer to a `Range` request) are not printed by the list reporter; range requests are unimplemented either way (TASKS follow-up). Cleanup is checked through the API (row gone, URL 404); the bucket itself was not listed. **Not covered remotely:** cross-user isolation (covered by local integration tests), the external-reference GLB rejection (unit + integration), upload-slot expiry. The production Worker, production Neon and `ar-creator-assets` are untouched.

### REMOTE-CONVERT-01 — Cloudflare Workflow + Container, isolated dev Worker — 2026-11-22 — PASS (full remote run 18/18 in 1.5 min)

Target: Worker `ar-creator-dev` version `f0735057-3fa1-45ed-b5a1-398b9f6a2095` (build `f41be26`, Workers Paid), Workflow `ar-creator-dev-image-to-ar`, container application `ar-creator-dev-usdconvertercontainer-dev` (`basic`, max 3, internet disabled), R2 `ar-creator-assets-dev`, Neon development `ep-dark-butterfly-bctzb64e` (migrations 5/5). Run by the owner: `npm run db:remote -- remote-auth-test …`; temporary user removed afterwards.

| Check | Result |
|---|---|
| REMOTE-AUTH-01 (9) + REMOTE-CONTENT-01 (8) re-run | all pass on the Phase 2 build |
| REMOTE-CONVERT | display PNG (ring, 512 × 512) → **Workflow → GLB in the Worker → USDZ from the Cloudflare Container** → both in R2; auto alpha MASK; 40 × 40 cm; cookieless signed reads with `model/gltf-binary` / `model/vnd.usdz+zip`, checksums match, `glTF` / `PK` magic. **8.7 s** end to end for the test (the container application had 0 live instances before the run, so this includes a cold start) |

After the run `wrangler containers list` (read-only) showed the application `active` with 2 live instances (requests are spread over a pool of 3; instances sleep after 3 min idle).

**Not covered remotely:** the Milestone 7 UI on the edge (3D preview, image objects in experiences) beyond the shared API; converter outage and retry behaviour (tested locally); `basic` instance memory headroom with the largest (15 MB) images.

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

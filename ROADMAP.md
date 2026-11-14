# ROADMAP.md — Stages and Go/No-Go Gates

## P0 — Reality checks / feasibility

**Goal:** validate all risky runtime boundaries before polishing authoring UI.

- Apple image-anchor USDZ; Quick Look recognition on a real iPhone.
- Apple horizontal/vertical plane anchor exports on supported device.
- Android experimental native WebXR image tracking on a compatible Chrome build.
- Android floor Scene Viewer intent and fallback.
- Android wall Scene Viewer `enable_vertical_placement=true` on a real device.
- PNG alpha GLB + USDZ render visibly transparent in Scene Viewer and Quick Look.
- Cloudflare Containers resource viability for Python/OpenUSD/Blender toolchain.

**Gate:** reproducible test assets, source code, test device/version matrix and known failure modes. If a platform fails, record a blocker and product decision; do not fake success.

## P1 — Infrastructure vertical slice

Vite React/CSS Modules UI, Hono API, PostgreSQL + Drizzle/Hyperdrive, Cloudflare R2, auth, asset upload, published/private states, basic logging. **Gate:** a creator can securely create a draft and upload/retrieve a checked asset.

## P2 — Image-to-AR generator

Upload transparent PNG, set dimensions/alpha mode, generate GLB + USDZ via durable conversion, preview, save derivative, download. **Gate:** acceptance fixtures and native visual tests pass.

## P3 — Canonical scene editor

Placement mode selector, model/image nodes, inspector, camera/gizmos, save draft, undo/redo, labels/graphics, scene hierarchy. **Gate:** saved scene roundtrips; real-world dimensions verified.

## P4 — Interactions and compatibility

Actions registry, native primary CTA mapping, WebXR overlay interactions, Scene Viewer `link`, landing-page fallback, matrix in editor. **Gate:** no unsupported action silently disappears.

## P5 — Exporters and hosted viewers

iOS image/floor/wall USDZ exporter; Android image experimental WebXR runtime; Android floor/wall one compiled Scene Viewer GLB; feature detection, error states. **Gate:** all target runtime acceptance cases.

## P6 — Publishing, sharing and hardening

Cloudflare Workflows, retries/idempotency, immutable output keys, stable URL, QR code, preview, statuses, analytics, device compatibility, security, performance and accessibility audits. **Gate:** edit/republish retains last-good URL and output during errors.

## Prioritization rule

Build minimum testable end-to-end vertical slices. Treat optional cutout/extrusion, audio, video, complex hotspots and team features as post-MVP unless user explicitly reprioritizes them.

## Spec review findings (2026-11-14)

Conflicts resolved by ADR:

| # | Finding | Resolution |
|---|---|---|
| 1 | Runtime IDs: MASTER_PROMPT §8 has 5 (`ios_quicklook_plane`), CAPABILITIES.md has 6 | ADR-007: six runtimes |
| 2 | Support vocabulary differs (MASTER_PROMPT §8 vs CAPABILITIES.md vs §7 badges) | ADR-007: CAPABILITIES.md vocabulary + badge mapping |
| 3 | No canonical coordinate frame; wall/image axis conventions undocumented by vendors | ADR-005 + P0 orientation probes (H1–H3) |
| 4 | `usdchecker`/`usdzip` CLIs are not in pip `usd-core` 26.x; Apple checker is macOS-only | ADR-008 |
| 5 | WebP is an accepted upload type but is not core glTF and is not allowed in USDZ | ADR-009: normalize to PNG first (pending) |
| 6 | Table names differ (`user_accounts`/`revisions` in MASTER_PROMPT §9 vs `users`/`experience_revisions` in DATA_MODEL.md) | Use DATA_MODEL.md names when migrations are written |
| 7 | Package name `capability-registry` (ARCHITECTURE.md) vs `capabilities` (AGENTS.md) | `packages/capabilities` |

Open questions / feasibility risks (not resolved by code):

| Risk | Impact | Mitigation / next proof |
|---|---|---|
| Chrome WebXR image tracking ships only behind `chrome://flags` (WebXR incubations) and its API shape (`trackedImages`, `getImageTrackingResults`) is a draft | Most real Android visitors in image mode will get the 3D-preview fallback, not AR | Adapter + probe built. 2026-11-14: tracking + DOM overlay worked on one Chrome 157 device (AND-IMG-01 PARTIAL; flag state not recorded). Still need AND-IMG-02 (default config) to confirm how many visitors fall back. Product owner should accept this explicitly |
| UA-reported tracked-image width echoes the registered width (Chrome 157) | Cannot auto-detect a print at the wrong scale; content will be mis-scaled silently | ADR-012: never use it as evidence; public page tells creators/visitors the exact print width; physical size checked by humans |
| Native viewers fetch assets without cookies/headers | "Signed access for drafts" cannot use auth headers for Scene Viewer/Quick Look; private test links need unguessable, expiring capability URLs in the path/query | Design in P1 R2 work; intent encoder already preserves query strings |
| Scene Viewer / Quick Look honouring `doubleSided`, BLEND sorting, and USD `opacityThreshold` | Transparent/two-sided cards may render differently | `alpha-steps` (double-sided) + alpha P0 cases; fallback: emit back-face geometry |
| Baked text/panels for Scene Viewer & Quick Look need server-side text rasterization | P4 dependency on a font/raster pipeline (licensing, determinism) | Plan as its own spike before P4 |
| Model (glTF→USD) conversion fidelity and cost (materials, animation, Blender) | Container size/time unknown; flat images measured only | Benchmark before committing to Cloudflare Containers vs external worker |
| Auth provider unspecified | Blocks P1 ownership/authZ | Owner decision needed |
| EXIF orientation in JPEG | Raw-byte embedding may display rotated | Normalize when orientation ≠ 1 (ADR-009) |
| In-app browsers (social apps) often lack `rel="ar"` / intent handling | Launch silently fails | `resolveRuntime` treats missing Quick Look as preview; add "open in Safari/Chrome" guidance |

## Dependency order for the next phases

P0 device results (axes, alpha, CTA) → P2 converter adjustments → P4 compilers. P1 infrastructure is independent of device results and can proceed in parallel once auth is decided. The Android WebXR probe gates the P5 image runtime scope.

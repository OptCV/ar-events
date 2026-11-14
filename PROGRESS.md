# PROGRESS.md — Actual Implementation State

**Updated:** 2026-11-14  
**State:** P0 runtime-proof kit (incl. Android WebXR image probe) implemented and **structurally validated / desktop-tested**. **First device result: AND-IMG-01 PARTIAL** (native WebXR image tracking + DOM overlay worked on one Android/Chrome 157 device; visual/geometry checks outstanding). All other device rows NOT TESTED. No app/API/database code yet.  
**Current phase:** P0 — automated half done; device half blocked on hosting + devices.

## Implemented (automated evidence)

| Area | Location | Evidence |
|---|---|---|
| npm workspace, TS 5.9 strict, Vitest | `package.json`, `tsconfig.json`, `vitest.config.ts` | `npm run check` |
| Canonical schema v1 (placement union, nodes, actions, URL policy, Image-to-AR settings) | `packages/schema` | 10 tests |
| Audited launch utilities: Scene Viewer intent, Quick Look href + CTA message, central runtime router | `packages/platform-launch` | 14 tests incl. delimiter-injection, blob:/http: refusal |
| Capability registry (6 runtimes × 12 features) | `packages/capabilities` | 5 tests |
| Image-to-AR GLB generator (flat quad, OPAQUE/MASK/BLEND, original bytes embedded) | `packages/image-to-ar` | 41 tests; every fixture passes Khronos glTF-Validator with 0 errors/0 warnings |
| Image-to-AR USDZ generator + Quick Look anchoring (image/floor/wall) + structural validator | `services/usd-processor` (Docker) | 54 pytest tests in sandbox |
| Deterministic golden fixtures + shared geometry contract | `tests/fixtures`, `scripts/generate-*.ts` | hash-locked manifest; byte-identical regeneration |
| P0 device kit (7 GLB/USDZ pairs + device-lab page) | `scripts/build-p0.ts` → `out/p0/` | built locally; **not deployed**; USDZ byte-reproducible across rebuilds (ADR-011) |
| Android WebXR image runtime logic: adapter, preflight (timeout), tracker state machine, pose composition | `packages/webxr-image` | 16 tests |
| Android WebXR image-tracking probe (AND-IMG-01 harness, DOM overlay, JSON report) | `apps/p0-webxr-probe` → `out/p0/webxr/` | Playwright on desktop Edge: unsupported path, no console/CSP errors. **Never run on an AR device** |

## Commands actually run (2026-11-14, Windows 11, Node 24.19.0, Docker 29.8.0)

| Command | Result |
|---|---|
| `npm run typecheck` | pass (0 errors) |
| `npm test` | 4 files, **70/70 passed** |
| `npm run usd:build` | image `ar-creator/usd-processor:dev` (453 MB) |
| `npm run usd:test` | **54/54 passed** (sandbox: no network, read-only FS, 1 GB, 2 CPU) |
| `npm run fixtures` ×2 | byte-identical output |
| `P0_BASE_URL=https://p0-lab.example.workers.dev npm run p0:build` | 7 cases, 0 USD validation errors/warnings, GLB/USDZ heights match; probe built to `out/p0/webxr/` |
| *(probe session)* `npm run check:all` | Vitest 5 files **86/86**; pytest **55/55** |
| *(probe session)* `npm run test:e2e` (Playwright 1.64.1, local Edge) | **2/2 passed** |
| *(probe session)* `p0:build` twice, 3 s apart | identical USDZ hashes |

Not available yet: lint (ESLint/Prettier not configured), DB migrations, `apps/web` build.

## Not yet implemented or verified

- [ ] Any physical-device result (all TESTING.md matrix rows **NOT TESTED**).
- [ ] Vite/React app, Hono API, PostgreSQL/Drizzle/Hyperdrive, R2, auth, Workflows.
- [ ] Cloudflare Containers deployment of the USD processor.
- [ ] WebP/EXIF normalization; texture size limits.

## Known blockers

1. **Device tests** need (a) the P0 lab on public HTTPS (owner's Cloudflare account) and (b) an iPhone/iPad and an ARCore Android phone.
2. **Auth provider** is unspecified in the specs — needed before P1 ownership work.
3. Apple `usdchecker` needs macOS (ADR-008).

## Session handoff — 2026-11-14 / Claude Code

- Goal: spec review, toolchain, P0 proof-of-concept slice.
- Files changed: see `CHANGELOG.md` 2026-11-14 "P0 runtime-proof kit".
- Commands/tests actually run: table above.
- Device test evidence: none.
- Known blockers: above.
- ADRs added: ADR-005 … ADR-009.
- Tasks changed: P0/P1/P2/P4 items in `TASKS.md`.
- Next smallest testable step: deploy `out/p0` (`npx wrangler@4 deploy -c infra/p0-lab/wrangler.jsonc`), rebuild with the real `P0_BASE_URL`, redeploy, and run IOS-FLR-01 / AND-FLR-01 on devices.

## Session handoff — 2026-11-14 (2) / Claude Code

- Goal: Android WebXR image-tracking probe.
- Files: `packages/webxr-image/*`, `apps/p0-webxr-probe/*`, `scripts/serve-p0.ts`, `playwright.config.ts`, `tests/e2e/p0-lab.spec.ts`, `services/usd-processor/usd_processor/reproducible.py`, `scripts/build-p0.ts` (probe link, CSP `blob:` for GLTF textures, favicon).
- Found and fixed: USDZ hashes not reproducible (ZIP timestamps, ADR-011); `isSessionSupported` can hang (preflight timeout); preflight UI was blocked on asset preload.
- Device evidence: none. AND-IMG-01 needs an ARCore phone with Chrome "WebXR Incubations" enabled; quick local route: `npm run p0:build && npm run p0:webxr:dev`, then `adb reverse tcp:5173 tcp:5173` and open `http://localhost:5173` on the phone.
- ADRs: ADR-010, ADR-011.
- Next smallest testable step: run AND-IMG-01 (flag on) and AND-IMG-02 (flag off) and paste the probe's JSON report into `TESTING.md`.

## Session handoff — 2026-11-14 (3) / Claude Code

- Goal: review the AND-IMG-01 device report, fix probe defects, commit Phase 0, plan Phase 1.
- Device evidence: AND-IMG-01 PARTIAL (see `TESTING.md` "Device results").
- Fixed (probe 0.2.0, ADR-012): UA width echo flagged; device identity via UA Client Hints; tester-observation fields; raw frame counts; duration and end reason.
- Commands: `npm run check:all` → Vitest 91/91, pytest 55/55; `npm run test:e2e` → 2/2; `p0:build` → `img-overlay.glb` SHA unchanged (`2b1167ae…`), so the device result applies to the current asset.
- Next device step: re-run AND-IMG-01 with probe 0.2.0, filling in every observation; run AND-IMG-02 (flag off).
- Committed Phase 0 as `ddf4aa9` on `webxr-feature` (not pushed).
- Phase 1 (uncommitted): Better Auth evaluated and accepted (ADR-013) after a local-workerd spike (`spikes/auth-workers`, 16/16 checks); single same-origin Worker proposed (ADR-014); Phase 1 slice plan in `ROADMAP.md`; P1 tasks expanded.
- Phase 1 blockers (owner decisions): Postgres provider/region, email provider, Workers Paid plan, upload path.
- Next smallest testable step (P1-1): scaffold `apps/web` + `apps/api` as one Worker with `@cloudflare/vite-plugin` and prove `/api/health` + SPA fallback in `vite dev` and in a production build.

# PROGRESS.md — Actual Implementation State

**Updated:** 2026-11-14  
**State:** P0 runtime-proof kit implemented and **structurally validated**. **No physical-device test has been executed.** No app/API/database code yet.  
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
| P0 device kit (7 GLB/USDZ pairs + device-lab page) | `scripts/build-p0.ts` → `out/p0/` | built locally; **not deployed** |

## Commands actually run (2026-11-14, Windows 11, Node 24.19.0, Docker 29.8.0)

| Command | Result |
|---|---|
| `npm run typecheck` | pass (0 errors) |
| `npm test` | 4 files, **70/70 passed** |
| `npm run usd:build` | image `ar-creator/usd-processor:dev` (453 MB) |
| `npm run usd:test` | **54/54 passed** (sandbox: no network, read-only FS, 1 GB, 2 CPU) |
| `npm run fixtures` ×2 | byte-identical output |
| `P0_BASE_URL=https://p0-lab.example.workers.dev npm run p0:build` | 7 cases, 0 USD validation errors/warnings, GLB/USDZ heights match |

Not available yet: lint (ESLint/Prettier not configured), Playwright, build (no apps), DB migrations.

## Not yet implemented or verified

- [ ] Any physical-device result (all TESTING.md matrix rows **NOT TESTED**).
- [ ] Android WebXR image-tracking probe.
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
- Next smallest testable step: deploy `out/p0` (`npx wrangler@4 deploy -c infra/p0-lab/wrangler.jsonc`), rebuild with the real `P0_BASE_URL`, redeploy, and run IOS-FLR-01 / AND-FLR-01 on devices. In parallel (code): Android WebXR image-tracking probe page.

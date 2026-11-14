# CLAUDE.md — Claude Code Session Guide

Read and follow [`AGENTS.md`](./AGENTS.md); its constraints are authoritative. This file specifies a predictable Claude-oriented workflow without duplicating source-of-truth engineering rules.

## Session startup

1. Read `PROGRESS.md`, then `TASKS.md` and accepted decisions in `DECISIONS.md`.
2. Inspect actual repository files and package scripts. This bundle may be installed before any implementation exists; **do not assume files are present**.
3. Read `PLATFORM_ROUTING.md`, `CAPABILITIES.md`, and the subsystem spec for the assigned task.
4. State what is implemented versus only specified. Outline one testable vertical slice.

## Implementation loop

- Make focused, minimal changes to typed React/Hono/Drizzle or converter code as appropriate.
- Avoid adding Next.js, Tailwind, shadcn, unrequested frameworks or image-tracking SDKs.
- Keep metadata/asset processing reproducible with deterministic fixtures.
- Use the central runtime mapping: image Android=experimental WebXR; non-image Android=Scene Viewer; all iOS=Quick Look.
- Preserve transparent PNG alpha for both `GLB` and `USDZ` conversion. Use separate tracking-image and display-image types.
- Never claim native device output or AR tracking is verified without evidence.
- Implement guarded feature detection, meaningful errors and landing-page fallbacks.

## Verification

Discover the actual available scripts, then run what exists (typecheck, lint, Vitest, Playwright, converter tests, build). If not yet implemented, mark as pending, do not invent passing checks. Record commands and outcomes in `PROGRESS.md`.

## Handoff response format

1. Changed behavior and files.
2. Tests run, with results.
3. Unverified device behavior and blocked tasks.
4. Updates to `TASKS.md`, `PROGRESS.md`, `CHANGELOG.md`, and any ADR.
5. Smallest next action.

Never overwrite `DECISIONS.md` history; append a new numbered entry for significant decisions.

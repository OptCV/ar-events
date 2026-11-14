# AR Creator — Specification and AI Maintenance Pack

This repository holds the specification pack plus the first P0 proof-of-concept code (no app yet). The product is a Vite + React + Hono + PostgreSQL + Cloudflare no-code AR creator. Read `MASTER_PROMPT.md` for the full requested build.

## Start here

1. **Human product owner:** read `MASTER_PROMPT.md`, `PLATFORM_ROUTING.md`, `IMAGE_TO_AR.md`, `DESIGN.md`, and `ROADMAP.md`.
2. **Any coding agent:** read `AGENTS.md` and `PROGRESS.md` first, then `TASKS.md`, `DECISIONS.md`, `PLATFORM_ROUTING.md`, and `CAPABILITIES.md`. Follow `CLAUDE.md` if applicable.
3. **Runtime engineer:** read `ARCHITECTURE.md`, `DATA_MODEL.md`, `CAPABILITIES.md`, `TESTING.md`, `SECURITY.md`.
4. **Before changing routing or exporters:** read `PLATFORM_ROUTING.md` and log an ADR in `DECISIONS.md`.

## Development quickstart

Prerequisites: Node ≥ 22, Docker. (No host Python needed; OpenUSD runs in a container.)

```sh
npm install
npm run db:up          # local PostgreSQL 17 in Docker + gitignored .env and apps/web/.dev.vars (random local secrets)
npm run db:migrate     # apply packages/db migrations to the LOCAL database
npm run dev            # app: SPA + Hono API in one Worker (workerd) at http://localhost:5173
npm run build          # production build → apps/web/dist (client assets + Worker)
npm run preview        # serve the production build in workerd
npm run check          # typecheck (regenerates Worker types) + Vitest
npm run usd:build      # build the sandboxed OpenUSD processor image
npm run usd:test       # pytest inside the sandbox
npm run test:db        # database integration tests (needs db:up)
npm run test:integration  # auth/API integration tests against local Postgres
npm run db:remote -- status --env development   # Neon: guarded remote ops (see infra/db/NEON.md)
npm run check:all      # check + test:db + test:integration + usd:test
npm run fixtures       # regenerate golden fixtures (must be byte-identical)
P0_BASE_URL=https://<host> npm run p0:build   # P0 device kit → out/p0/ (incl. WebXR probe at out/p0/webxr/)
npm run p0:serve       # serve out/p0 locally with its _headers
npm run test:e2e       # Playwright: p0 lab + app (dev and production build) using installed Edge (PW_CHANNEL=chrome to switch)
npm run p0:webxr:dev   # probe dev server; phone via `adb reverse tcp:5173 tcp:5173`
```

Layout: `apps/web` (SPA + deployable Worker config), `apps/api` (Hono API), `packages/{db,contracts,schema,platform-launch,capabilities,image-to-ar,webxr-image}`, `apps/p0-webxr-probe`, `services/usd-processor`, `spikes/auth-workers` (reference only), `tests/{fixtures,e2e}`, `scripts`, `infra/{p0-lab,db}`. See `PROGRESS.md` for verified status.

## Product invariants

- iOS image / floor / wall -> appropriately anchored USDZ -> Quick Look.
- Android image -> experimental browser WebXR image tracking; no fallback tracker SDK.
- Android floor / wall -> Google Scene Viewer; wall requests `enable_vertical_placement=true`.
- A tracking target image and a displayed image-in-AR are different asset roles.
- Image-to-AR generates **both GLB and USDZ**, preserving transparency.
- Creator allows custom artifacts; exporter must map them to supported native features or visible landing-page fallbacks.
- Vite/React/CSS Modules + Hono Workers + PostgreSQL/Drizzle/Hyperdrive + R2 + Workflows + Containers.

## File map

| File | Authority |
|---|---|
| `MASTER_PROMPT.md` | Complete generation/build brief |
| `AGENTS.md` | Shared AI agent behavior and guardrails |
| `AGENT.md` | Singular compatibility entry point |
| `CLAUDE.md` | Claude-specific context and session checklist |
| `DESIGN.md` | UX, layout, design system, accessibility |
| `ARCHITECTURE.md` | Modules, Cloudflare services, build/deploy boundaries |
| `PLATFORM_ROUTING.md` | Exactly which runtime each placement uses |
| `CAPABILITIES.md` | Per-element and action capabilities/fallbacks |
| `IMAGE_TO_AR.md` | Transparent PNG-to-GLB/USDZ rules |
| `DATA_MODEL.md` | Scene schema, provenance and APIs |
| `TESTING.md` | Reproducible and device test protocols |
| `SECURITY.md` | Threat model and controls |
| `ROADMAP.md` | Phases and go/no-go gates |
| `TASKS.md` | Checkable backlog |
| `DECISIONS.md` | ADR history, append-only |
| `PROGRESS.md` | Current verified status and blockers |
| `CHANGELOG.md` | Record of document/code changes |

## Document update rule

Update the smallest authoritative document that owns a decision; cross-link instead of duplicating. When a change affects behavior, update capability/routing docs, tests, tasks, and decision history together. Do **not** claim code or device test completion until artifacts and evidence exist.

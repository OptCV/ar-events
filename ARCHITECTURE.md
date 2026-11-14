# ARCHITECTURE.md — Service and Deployment Boundaries

## Target repository layout (proposed)

```
apps/
  web/                 # Vite + React + CSS Modules creator/public experience
  api/                 # Hono Worker endpoints
packages/
  schema/              # Zod contracts + migrations
  scene/               # canonical scene graph and transform utilities
  capability-registry/ # runtime feature mapping
  ui/                  # reusable styled components
  platform-launch/     # Scene Viewer intent / Quick Look launch utilities
services/
  usd-processor/       # Python OpenUSD tools in isolated container
  scene-compiler/      # GLB composition and reusable image conversion
infra/
  cloudflare/          # Workers/R2/Workflows/Containers configs
  db/                  # Drizzle migrations
 tests/
  fixtures/            # source images/models + approved expected metadata
```

This layout is a recommendation, not an assertion that files exist.

## Service responsibilities

**Web UI:** drafts, uploads, editor, asset preview, platform compatibility review, public experience player, device launch. No heavy file conversion in browser required for published output.

**Hono Worker:** auth, access checks, type/size validation, asset upload authorization, draft persistence, state transition, trigger durable workflow, public manifest delivery.

**PostgreSQL:** authoritative ownership, versions, publication pointers, jobs, derivatives and diagnostics. Connect through Hyperdrive in Workers; transactionally promote published revision only after outputs are ready.

**R2:** all user originals, derived files, temporary outputs, immutable published assets. Use cache and CORS rules appropriate for WebXR image fetch and native viewers.

**Workflows/Queues:** orchestrate conversion, scene compilation, validation and publish, with idempotency + bounded retries. Avoid unrelated job fanout on each action.

**Heavy conversion container:** accept signed short-lived references or authenticated job tokens, download authorized inputs, operate within CPU/RAM/disk/network limits, generate GLB/USDZ, run validation, upload outputs to R2, return structured diagnostics. Must never trust uploaded file content or filenames.

## Processing contracts

```
POST /internal/convert-image
  input: sourceAssetId + image settings + idempotencyKey
  output: glbAssetId + usdzAssetId + dimensions + diagnostics
POST /internal/compile-experience
  input: immutable revisionId + runtime + idempotencyKey
  output: outputAssetId + validationReport
```

Use authenticated internal APIs/bindings, not public unauthenticated webhooks. Generate output content hashes. Every compiled output references exactly one revision.

## Exporters and renderers

- `iosUsdCompiler`: image => reference-image anchor; floor => horizontal plane; wall => vertical plane; exports USDZ with supported content and primary Quick Look CTA metadata configured separately at launch.
- `androidWebXRImageRuntime`: loads tracking reference + scene GLB, uses native experimental WebXR image tracking, feature detection, pose updates, DOM overlay and action handlers.
- `androidSceneViewerCompiler`: floor/wall => **one GLB file** with all supported geometry, textures, baked labels and alpha-image planes. Launch adapter includes optional link/title, mode and wall placement flag.
- `desktopPreview`: shared scene in Three.js; explicitly not a native AR runtime.

## Publishing sequence

`Draft saved` → `revision snapshot` → `validate` → `plan runtime outputs` → `derive source assets` → `compile USDZ + GLB` → `package/validate` → `upload immutable outputs` → `publish pointer transaction` → `CDN + share URL`.

For image mode, Android needs a published WebXR scene manifest and accessible image target/GLB; Scene Viewer GLB is not used for Android image tracking. For floor/wall, compile a complete Scene Viewer-compatible GLB; no WebXR scene.

## Failure semantics

Any failed output stays failed/pending; do not elevate to ready. If a new revision fails, keep the prior published revision visible. Partial publication is a deliberate product state requiring user-facing explanation. Retry only idempotent operations and avoid duplicate billing/storage.

## Open questions requiring proof

- OpenUSD/Blender tools memory and disk under Cloudflare Container instance sizes.
- Model texture/animation conversion fidelity to iOS and Scene Viewer.
- iOS preliminary anchoring support on target OS versions.
- Experimental WebXR extension surface in tested Chrome builds.
- Transparent USD material visual fidelity on actual Quick Look device.
- Native wall placement behavior and supported intent parameters on tested Scene Viewer versions.

Record proof in `TESTING.md`; record changes in `DECISIONS.md`.

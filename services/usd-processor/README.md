# usd-processor

Isolated OpenUSD (usd-core 26.8, Python 3.12) processor. Currently implements **Image to AR Object (flat) → USDZ**
with optional Quick Look anchoring (`image` / `floor` / `wall`). GLB output lives in `packages/image-to-ar`; both
follow the shared quad contract in `tests/fixtures/geometry_golden.json`.

```sh
npm run usd:build     # docker build -t ar-creator/usd-processor:dev
npm run usd:test      # pytest in the sandbox below, fixtures mounted read-only
```

Sandbox used by `scripts/usd.ts`: `--network none --read-only --tmpfs /tmp --tmpfs /var/tmp --memory 1g --cpus 2 --pids-limit 128`,
non-root user. OpenUSD's crate writer needs a writable `/var/tmp`.

CLI (argv only, no shell interpolation):

```sh
python -m usd_processor image-plane --image in.png --out out.usdz --width-m 0.5 --alpha-mode BLEND \
  [--alpha-cutoff 0.5] [--double-sided] [--pivot center|bottom-center] [--orientation upright|flat] \
  [--anchor none|image|floor|wall] [--tracking-image target.png --tracking-width-m 0.2]
```

Exit codes: 0 ok · 2 conversion error · 3 structural validation errors. Output is JSON.

## Validation

usd-core 26.x no longer ships the Python `ComplianceChecker` (`usdchecker --arkit`). `validate.py` runs all registered
`UsdValidation` validators plus explicit Quick Look profile checks (stored/64-byte-aligned zip, root `.usdc`, allowed file
types and shader IDs, packaged assets, meters/Y-up, anchoring consistency). Apple's preliminary schemas are *not registered*
in OpenUSD, so applied schemas are read from authored `apiSchemas` metadata. This is **structural validation only** —
it does not prove Quick Look detection or rendering.

## HTTP converter (Cloudflare Container, ADR-023)

`python -m usd_processor serve --port 8080` is the default command of the `runtime` image stage: what Wrangler builds
for the `UsdConverterContainer` Cloudflare Container, which is started with internet access disabled.

```
GET  /healthz                                   {"ok": true, "converterVersion": "...", "usd": "0.26.8"}
POST /v1/image-plane?width_m=0.5&alpha_mode=BLEND[&alpha_cutoff=0.5&double_sided=0|1&pivot=center|bottom-center&orientation=upright|flat]
     body = image bytes (Content-Length required, <= 32 MiB), optional X-Source-SHA256
     200: u32be(len(json)) + json + usdz     400/411/413: bad request     422: conversion or validation failure
```

The Worker sends the source and stores the result; this process has no storage, credentials or network.
Locally (Windows cannot run Cloudflare Containers): `npm run usd:serve` builds the runtime image and runs it on
`127.0.0.1:8790` with a read-only root FS and 1 GiB / 2 CPU / 128 pids limits; `vite dev` reaches it through
`USD_CONVERTER_URL` (development only). Image stages: `base` → `test` (pytest; `npm run usd:build|usd:test`) → `runtime`.

## Texture preparation (ADR-025)

`POST /v1/texture?max_edge=2048` (body: PNG/JPEG/WebP) returns the frame `u32be(len) + JSON + texture`, where the
texture is PNG (anything with transparency, or lossless sources) or JPEG q92 4:4:4 (opaque lossy sources), rotated
upright from EXIF and downscaled in premultiplied alpha. Pillow is pinned (13.0.0). WebP test fixtures:
`node --experimental-strip-types scripts/usd.ts fixtures-webp` (writes `tests/fixtures/normalize/` + SHA256SUMS).

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

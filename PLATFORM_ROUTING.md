# PLATFORM_ROUTING.md — Runtime and Launch Contract

This is authoritative for platform routing. **Do not replace a runtime without an explicit product decision.**

| Placement | Apple output/runtime | Android output/runtime | Android specifics |
|---|---|---|---|
| `image` | image-anchored `.usdz` / Quick Look | hosted scene GLB + tracking image / **experimental native WebXR** | user gesture; feature detection; no Scene Viewer image tracking |
| `floor` | horizontal-plane `.usdz` / Quick Look | hosted composed `.glb` / **Google Scene Viewer** | explicit intent; `mode=ar_preferred` preferred; 3D fallback |
| `wall` | vertical-plane `.usdz` / Quick Look | hosted composed `.glb` / **Google Scene Viewer** | `enable_vertical_placement=true`; physical-device confirmation |

## Android Scene Viewer intent requirements

For floor/wall, construct a validated Chrome `intent://arvr.google.com/scene-viewer/1.0?...#Intent;...;end;` with:

- `file`: HTTPS URL of a **composed, fully accessible GLB**. Scene Viewer does not load browser `blob:` URLs as exported full scenes reliably.
- `mode=ar_preferred`: AR first, 3D fallback (Google app intent).
- `S.browser_fallback_url`: URL for graceful fallback in a web-launched Google app intent.
- Optional `link`: one primary CTA URL supported by native viewer.
- Optional `title`, `resizable`.
- **Wall only:** `enable_vertical_placement=true`.

Use the Google app package for the broad `ar_preferred` flow. If deciding to use `com.google.ar.core` for `ar_only`, implement its **different documented parameters**, and record an ADR. Do not use `ar_only` against the Google app target.

Google docs: https://developers.google.com/ar/develop/scene-viewer

## Android image tracking

Use a normal HTTPS public page to launch `immersive-ar` WebXR with the image tracking extension available to that browser. Feature detection, registration, XR frame results, pose updates and lifecycle belong to the image viewer. Experimental Chrome flag instructions may be shown, but setting flags cannot be automated.

No MindAR, Zappar, AR.js, hosted image recognition, or Scene Viewer fallback for *tracking*. An unsupported viewer may show regular 3D preview and a compatibility explanation.

## Apple

All three modes compile to USDZ. Use Safari-compatible `<a rel="ar">` launch and native Quick Look. Image mode uses `Preliminary_ReferenceImage` and the image relationship; floor/wall use plane alignment metadata. Quick Look CTA/banner is a native limited surface, not arbitrary HTML interaction. Serve correct MIME and HTTPS assets.

## Public page resolution

1. Read published immutable revision and placement mode.
2. On iOS Safari-compatible device: Quick Look action for USDZ.
3. On Android: image => WebXR start UI; floor/wall => Scene Viewer launch.
4. Desktop/unsupported: 3D preview, asset/target information, clear compatibility state.
5. Preserve all external links on landing page; route only supported primary links to native actions.

Never infer that native AR actually started from mere page load. Capture only observable launch intent and supported result signals.

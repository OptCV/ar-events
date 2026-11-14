# CAPABILITIES.md — Feature Support and Fallback Registry

**Status:** planning assumptions requiring physical-device verification. Code mirror: `packages/capabilities` (keep in sync; ADR-007 vocabulary, six runtimes). No entry is device verified yet. Status codes: `native`, `compiled_visual`, `fallback_page`, `experimental`, `unsupported`, `verify`.

| Element / behavior | iOS Quick Look | Android image WebXR | Android floor/wall Scene Viewer |
|---|---|---|---|
| 3D model | compatible USDZ geometry | Three.js GLB | composed GLB |
| Target image recognition | image anchoring | experimental WebXR extension | **unsupported** |
| Floor surface placement | plane anchoring | not selected in this product | Scene Viewer native |
| Wall surface placement | vertical plane anchoring | not selected in this product | Scene Viewer with `enable_vertical_placement=true` |
| PNG-to-AR flat card | USD textured quad with alpha | GLB textured quad with alpha | GLB textured quad with alpha |
| Semitransparency | USD opacity, verify on device | GLB `BLEND`, verify | GLB `BLEND`, verify |
| Cutout silhouette geometry | compiled USD | compiled GLB | compiled GLB |
| Text label / static panel | compatible USD geometry/text | Three.js text/panels | baked visual GLB geometry |
| Logo/graphic | textured USD geometry | GLB/Three.js | composed textured GLB |
| Model animation | compatible USD animations | supported Three.js clips | native GLB supported subsets; typically first clip |
| Primary external CTA | Quick Look action/banner | WebXR DOM overlay | Scene Viewer `link` |
| Additional external links | landing page | overlay / landing page | landing page |
| Multiple clickable 3D hotspots | landing page fallback | raycast actions (feature-tested) | landing page fallback |
| Arbitrary HTML UI within AR | **unsupported** | DOM overlay if browser supports | **unsupported** |
| Custom viewer chrome | limited native options | page + DOM overlay | limited native options |
| Audio | compatible Quick Look USD audio | browser audio after gesture | documented `sound` parameter; constraints apply |
| Video planes | feature-gate / fallback | conditional, future | fallback page |
| Run creator-side JS actions inside AR | **unsupported** | controlled app actions only | **unsupported** |

## Rules for compiler implementation

1. **`native`:** output a real target-runtime feature with tests.
2. **`compiled_visual`:** render a noninteractive visual representation of the node (e.g. an info card as textured mesh).
3. **`fallback_page`:** preserve the action/information on the page, and warn in the editor.
4. **`experimental`:** feature-detect on-device and show unsupported state cleanly.
5. **`unsupported`:** don't compile a fake feature. Warn, disable publishing of critical functionality or require a fallback choice.
6. **`verify`:** do not declare supported from a desktop preview alone.

## Capability registry schema sketch

```ts
type Runtime =
  | 'ios_quicklook_image' | 'ios_quicklook_floor' | 'ios_quicklook_wall'
  | 'android_webxr_image' | 'android_scene_viewer_floor' | 'android_scene_viewer_wall';
type Support = 'native' | 'compiled_visual' | 'fallback_page' | 'experimental' | 'unsupported' | 'verify';
interface CapabilityEntry {
  elementType: string;
  runtime: Runtime;
  status: Support;
  converter?: string;
  fallback?: 'landing_page' | 'static_geometry' | 'disabled';
  message: string;
  lastDeviceVerified?: { device: string; os: string; version: string; date: string };
}
```

A single primary native CTA can map to Quick Look's documented banner callback or Scene Viewer's `link`; multiple links must not pretend to be clickable in an exported GLB. Update this file after platform tests and add evidence in `TESTING.md`.

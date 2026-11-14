# MASTER DEVELOPMENT PROMPT — Cross-Platform No-Code AR Creator

> Version: 3.0 · Updated: 2026-11-14 · Status: implementation specification
>
> Use this prompt together with `AGENTS.md`, `CLAUDE.md`, `DESIGN.md`, `ARCHITECTURE.md`, `CAPABILITIES.md`, `IMAGE_TO_AR.md`, `PLATFORM_ROUTING.md`, `DATA_MODEL.md`, `TESTING.md`, `ROADMAP.md`, `TASKS.md`, and `DECISIONS.md`. These files are part of the deliverable, not optional notes.

## 1. Mission

Build a **functional, accessible, no-code, browser-based AR creation and publishing platform**. A creator should be able to upload 3D models, images, logos, and other supported content; select an AR placement type; assemble a scene visually; add labels, banners, links and interactions; preview platform-specific results; publish one URL; and republish safely.

The three placement types are:

1. **Image anchored:** place content relative to a printed or displayed image that the AR runtime recognizes.
2. **Floor/horizontal:** place content on a detected horizontal surface without a reference image.
3. **Wall/vertical:** place content on a detected vertical surface without a reference image.

**Routing rules are non-negotiable:**

| Placement | Apple iOS/iPadOS | Android |
|---|---|---|
| Image anchor | Generate an image-anchored USDZ; launch AR Quick Look | Use native, experimental WebXR image tracking in Chrome; no third-party image tracker |
| Floor | Generate a horizontal-plane USDZ; launch AR Quick Look | Generate a self-contained, remotely hosted GLB and launch **Google Scene Viewer** |
| Wall | Generate a vertical-plane USDZ; launch AR Quick Look | Generate a self-contained, remotely hosted GLB and launch **Google Scene Viewer with `enable_vertical_placement=true`** |

**Never use WebXR for Android floor/wall modes. Never use Scene Viewer for Android image recognition.** Android image tracking is intentionally experimental; unsupported devices receive a clearly labeled preview/fallback, not a counterfeit AR experience.

## 2. Tech stack — required

- **Web:** Vite, React, TypeScript, React Router, React Three Fiber, Three.js, Drei, Zustand, TanStack Query, Zod, React Hook Form where useful.
- **CSS:** CSS Modules and plain CSS with design tokens. **No Tailwind CSS, Next.js, shadcn/ui, Bootstrap or Material UI.** Write accessible, reusable React components.
- **Backend:** Hono and TypeScript running in Cloudflare Workers. Validate boundaries with Zod.
- **Database:** managed PostgreSQL, Drizzle ORM, migrations, Cloudflare Hyperdrive for Worker connectivity.
- **Files and delivery:** Cloudflare R2, Workers Static Assets/CDN, signed or directly authorized uploads, versioned published asset URLs.
- **Async:** Cloudflare Workflows for publish orchestration; Queues for supporting jobs; retries must be bounded and idempotent.
- **Heavy conversion:** isolated Python/OpenUSD processor via Cloudflare Containers if resource budgets and binary dependencies permit. Use `usdzip`, `usdchecker`, validated glTF-to-USD conversion tools, and optionally headless Blender. Do not execute this toolchain in ordinary Worker requests. If Containers cannot run it reliably, use the same processing API on an isolated external worker and document why.
- **Other:** Wrangler, Vitest, Playwright, device-testing checklists, Cloudflare observability and Turnstile where appropriate.

## 3. Creation user journey

Use a persistent, autosaved wizard:

**Dashboard → New Experience → Placement Mode → Add Assets → Build Scene → Add Actions → Customize → Preview and Compatibility → Publish → Share.**

Drafts must be resumable; creators can navigate between steps and switch placement modes without losing their content. Switching placement requires explicit preview of coordinate changes and any incompatible content. Never silently discard scene nodes.

### Step 1 — Create an experience

Collect a name, optional description, category, thumbnail, preferred slug, visibility (draft/private test/public), and optional brand profile. Auto-create a draft. Offer templates (poster activation, product tabletop, wall artwork, floor sculpture, transparent graphic signage).

### Step 2 — Choose placement

**Image target mode:** upload a PNG/JPG *tracking reference* (distinct from displayed content images); specify the real physical width in cm/in. Derive height from aspect ratio. Show image-resolution, contrast and feature-density heuristics as warnings, not guaranteed trackability. Use the center of the tracking image as the authoring anchor.

**Floor:** visualize a horizontal plane and real-world dimensions; provide ground contact, scale, orientation, and optional static ground shadow. The Android runtime is Scene Viewer, so do not design custom AR placement reticles/HTML controls that would require a WebXR scene.

**Wall:** visualize a vertical plane with scale, depth offset, and hanging-height guides. Use Apple vertical-plane USD anchoring and Scene Viewer vertical placement on Android. Clearly explain that results depend on physical-device detection and the user's selected surface.

### Step 3 — Add assets

Support GLB first; permit glTF plus dependencies through a validated import path, and USDZ as an advanced iOS override. Accept PNG/JPG/WebP images for visual content, plus approved audio formats if supported. Store originals in R2, inspect and sanitize uploads, show thumbnails and scene dimensions, surface unsupported formats and material conversion errors.

**Important: support two different uses for images, surfaced as separate actions:**

1. **Use as tracking target** — image recognition reference in image-anchor mode; **does not** automatically become visible scene geometry.
2. **Add image as AR object** — convert a user-supplied image into reusable GLB and USDZ geometry, preserving its pixel alpha; **does not** automatically become a tracking target.

Provide a prominent **“Turn image into AR object”** action in the asset library and in the Add Element menu. These actions may use the same uploaded source but must remain separate typed roles.

### Step 4 — Build the scene

Create a three-panel desktop editor:

- **Left:** scene hierarchy, assets, Add Element palette and reusable components.
- **Center:** Three.js viewport, placement plane/target, orbit/pan/zoom, side/front/top views, real-scale ruler, grid, gizmos, snapping, multi-select, undo/redo.
- **Right:** context-sensitive inspector for transform, styling, material, animation, content and interaction settings.

Support multiple 3D models and scene nodes. Store stable node IDs and an explicit hierarchy. Use metric coordinates and quaternions internally. Implement deterministic conversion from the canonical editor anchor frame to USD and WebXR/Scene Viewer output coordinates. Preserve real-world scale. Support object locking, hide/show, duplicate, order, alignment and reset.

### Step 5 — Add artifacts and interactions

The palette should support:

- 3D model (uploaded GLB / USDZ-compatible content).
- **Image as AR object**, including transparent PNG converted into a flat textured card or optional cutout/extruded form.
- Text label, title, caption, product details, price tag and info panel.
- Logo and graphic panels.
- 3D primitives, arrows, markers, pointers and static callouts.
- Primary CTA button, external link, phone/email, booking/product/social links.
- Hotspots and show/hide/toggle actions where runtime supports real scene input.
- Imported model animations, basic audio/narration and trigger settings where supported.
- Optional video and advanced behaviors as *future* capabilities, not implied MVP promises.

Separate **visual node** from **action definition**. Each action has an ID, trigger, validated URL/parameters, supported runtimes, and fallback mapping. No arbitrary user-supplied JavaScript or executable HTML.

**Export limitations:** Quick Look and Scene Viewer are native viewers, not custom HTML canvases. Neither guarantees arbitrary 3D buttons, DOM overlays, or custom click handlers. Their supported primary actions can be configured through Quick Look banner/CTA callbacks or Scene Viewer `link`. Represent additional links on the **public landing page**. Android **image mode** can use supported WebXR DOM overlays and Three.js interactions; Android **floor/wall** mode uses Scene Viewer and therefore cannot display WebXR UI overlays. Always show a platform-specific capability warning in the editor.

### Step 6 — Customize

Allow theme colors, approved fonts, text sizes, logos, launch poster, AR instructions, primary CTA copy, informational banners, loading states, scene-unit preferences and optional fixed/resizable scale behavior. Keep style controls platform-aware: website and WebXR overlays are highly customizable; Quick Look and Scene Viewer native chrome is not.

### Step 7 — Preview and compatibility

Use a normal 3D preview for all modes and mobile private test links for real AR tests. Provide toggleable iOS / Android preview with element badges: **native**, **compiled visual**, **fallback landing page**, **experimental**, **unsupported**. Preview is never evidence of physical-world tracking. Before publishing, present a compatibility checklist with explicit fallback locations for each unsupported action.

### Step 8 — Publish and share

Save an immutable revision, validate configuration and assets, compile platform packages asynchronously, run structural checks, store outputs in R2, then atomically update the published pointer after successful completion. Preserve the last successful published revision if new compilation fails. Return one public URL, QR code, preview link, platform statuses, and download links for generated files. Support unpublished, private-test, partially-ready, published, failed, and superseded states.

## 4. First-class image-to-AR conversion

This feature is mandatory and **independent of the placement mode**. It converts a 2D image into a **flat 3D-displayable asset**, not automatically a true volumetric reconstruction. Name the feature accurately: **Image to AR Object (2D/2.5D)**.

### UX

- Upload PNG/JPG/WebP; display transparent checkerboard preview when alpha exists.
- Choose physical width in cm/in/m, preserve intrinsic aspect ratio; set orientation and default pivot.
- Select output appearance: **Flat Image Plane** (default), **Alpha Cutout** (optional tighter silhouette geometry), and **Extruded Cutout** (future/advanced; configurable thickness and side material). No image-depth estimation is assumed.
- Set single-sided/double-sided, alpha mode (auto, MASK with configurable cutoff, BLEND for semitransparency), edge quality, and optional unlit/emissive style if supported.
- Preview with multiple checkerboard and dark/light/real-world backgrounds and rotate model to verify backs and normals.
- Click Generate; produce **both GLB and USDZ** with matching physical size, UVs and transparency. Save as reusable library assets; allow insertion into a scene or direct placement/publishing without a separate 3D model.
- Expose original, preview, conversion status, platform compatibility and download options. Preserve original alpha and do not destructively flatten against white/black.

### Engineering requirements

**GLB:** create a rectangular 2-triangle plane (or triangulated alpha silhouette for cutout mode) with pixel-correct UVs and an embedded texture. Preserve RGBA. Use glTF `alphaMode: BLEND` for graded alpha and `MASK` with `alphaCutoff` for binary cutouts, as appropriate; `doubleSided` is configurable. Favor physically predictable color management and test Scene Viewer compatibility; do not assume all material extensions work there.

**USDZ:** author matching mesh geometry, UVs, `UsdPreviewSurface` or verified compatible material, image texture RGB and **texture alpha wired to surface opacity** (or validated opacity threshold). Use correct texture color space and test on actual Quick Look devices. Include the PNG texture and dependencies in the USDZ package. Zero-alpha areas should visually show the environment, not a white/black rectangle. Preserve partially translucent areas where supported and document appearance differences across native viewers.

**Shape vs transparency:** an alpha-textured plane remains geometrically rectangular even when its center is transparent; this is acceptable for the flat mode. A true geometric hole or silhouette side wall requires the explicit cutout/extrusion conversion mode, not just an alpha texture. Do not describe a flat image as an AI-generated 3D sculpture.

**Tests:** opaque JPG, fully transparent PNG borders, holes within opaque shapes, semitransparent PNG shadows, thin antialiased edges, high-resolution logo, rotated double-sided sign, and both Android Scene Viewer and Apple Quick Look visual checks. Image target suitability checks must not be applied to this display-asset role unless it is also selected as a tracking image.

## 5. iOS compilation and Quick Look

Generate a single USDZ for the scene with supported geometry, textured planes, labels/callouts baked or represented in compatible USD, materials, animations and appropriate anchoring.

- Image mode: use Apple's `Preliminary_AnchoringAPI` with `preliminary:anchoring:type = "image"`, a `Preliminary_ReferenceImage`, and correct reference-image relation. Store width in meters in the database; **Apple `physicalWidth` is documented in centimeters**, so convert explicitly and test device behavior.
- Floor: use supported plane anchoring with horizontal alignment.
- Wall: use supported plane anchoring with vertical alignment.
- Compose content beneath an appropriate root anchor; carefully avoid nested independently anchored prims.
- Set default prim and units; normalize transforms; package every referenced texture and resource using `usdzip`; validate with `usdchecker` and ARKit-specific checks where available.
- Launch with Safari `<a rel="ar" href="...usdz">` including preview `<img>`, serve `model/vnd.usdz+zip`, and configure supported Quick Look `callToAction`/custom banner parameters. Handle a Quick Look action via the webpage's documented message event. Additional actions live on the landing page.
- Treat Apple's preliminary USD schema compatibility as version-dependent and test on supported real devices. Structural checks do not guarantee detection or visual rendering.

## 6. Android image-anchor runtime — experimental WebXR only

The image mode public page loads the target image, registered physical width and scene GLB / compiled assets, then requests a user-initiated `immersive-ar` session with whichever native image/marker tracking feature the tested browser actually implements. Isolate `image-tracking` versus evolving `marker-tracking` descriptors behind a capability adapter; do not assume draft syntax equals deployed Chrome syntax.

Track results on XR frames, apply image poses to the anchor group, then apply the creator-authored local transforms. Implement tracking acquired/lost/emulated states and proper session cleanup. Use WebXR DOM overlay for supported on-screen CTAs and Three.js raycasting for scene interactions where validated. Require HTTPS, camera permissions and an explicit Start AR gesture. Offer testing instructions for Chrome's experimental flag when appropriate; never auto-enable it or claim universal support.

## 7. Android floor/wall runtime — Scene Viewer, never WebXR

For **both** floor and wall experiences, compile the static 3D scene into **one remotely accessible GLB** compatible with Scene Viewer. Bake compatible visual labels, logos, images and information panels into geometry/materials; apply correct real-world size, ground/wall offsets and sensible pivot. A hosted `blob:` URL or a browser-only composition is not acceptable because Scene Viewer loads the GLB across an app boundary.

Launch via documented Android intent or a tested `<model-viewer>` Scene Viewer pathway; prefer a Google app explicit intent with `mode=ar_preferred` and `S.browser_fallback_url` where a graceful 3D fallback is needed. Include the `file` URL, optional `title`, optional primary `link`, and other supported parameters. For wall mode, set **`enable_vertical_placement=true`**. Use `resizable=false` only when the creator asks for fixed scale; validate its implications in AR. Test native intent handling with a real Chrome/Android device.

Scene Viewer is responsible for surface detection, placement, controls and the AR-native interface. **Do not** implement a bespoke WebXR hit-test viewer in these modes. Expose one supported external-link action if configured; move additional actions and unsupported custom UI to the public experience page. Document animation limitations (e.g. supported glTF playback differs from interactive WebXR state machines) and test transparent PNG-derived geometry in Scene Viewer.

## 8. Platform capability registry

Build a centralized typed registry, not scattered booleans, describing each feature's behavior in: `ios_quicklook_image`, `ios_quicklook_plane`, `android_webxr_image`, `android_scene_viewer_floor`, `android_scene_viewer_wall`.

Each entry defines `supported | compiled_visual | fallback | experimental | unsupported`, compile strategy, runtime requirements, user-facing explanation and test status. Before publishing, summarize any differences and allow the creator to adapt content. Canonical labels/buttons are **not** automatically interactive in all runtimes.

Initial expectations:

- Models/textured graphics/static information: export as compatible scene content, subject to conversion.
- PNG transparency: preserve both GLB/USDZ alpha; verify visually.
- Android image mode: browser overlays and custom interactions where WebXR DOM overlay supported.
- Android floor/wall: Scene Viewer offers model presentation and supported native primary `link` action, not arbitrary overlays or hotspots.
- iOS: Quick Look supported CTA/banner action; additional interactions on landing page.
- Video, multiple independently interactive objects, dynamic DOM within native viewers: only add after verified support or implement explicit fallback.

## 9. Canonical data and workflows

Use a versioned, Zod-validated **discriminated placement union** (`image | floor | wall`); separate `trackingTargetAssetId` from visual `displayImageAssetId` and from derived `glbAssetId/usdzAssetId`. Store `scene.nodes[]` with stable IDs, typed node kind, parent ID, transform (meters + quaternion + scale), material/style, and optional action reference. Store `actions[]` as structured validated commands. Store generated outputs by platform/placement/revision, and preserve provenance for derived assets (input hash, converter version, settings, diagnostics).

Support `experiences`, `revisions`, `assets`, `asset_derivatives`, `processing_jobs`, `generated_outputs`, `user_accounts`, and privacy-conscious analytics in PostgreSQL. Public pages load only immutable published revisions. Authoring endpoints must enforce ownership and authorization.

Suggested Hono API routes: `POST/GET /api/experiences`, `GET/PATCH/DELETE /api/experiences/:id`, `PUT /api/experiences/:id/draft`, `POST /api/assets/uploads`, `POST /api/assets/:id/convert-image-to-ar`, `GET /api/assets/:id/derivatives`, `POST /api/experiences/:id/validate`, `POST /api/experiences/:id/publish`, `GET /api/experiences/:id/jobs`, `GET /api/public/experiences/:slug`, and immutable asset delivery routes. Build schema-first service contracts, not fake handlers.

## 10. Cloudflare integration and reliability

- React app via Workers Static Assets / Cloudflare Vite plugin. Hono on Workers; use Cloudflare bindings in typed environment.
- PostgreSQL via Hyperdrive + Drizzle; use migrations and parameterized queries.
- R2 for upload originals, thumbnails, reference images, derived GLB/USDZ, and published revision outputs. Support large uploads using temporary authorization and completion verification; hash content; set correct MIME/CORS/cache headers.
- Workflows orchestrate model conversion, image-to-AR derivation, iOS and Android compilation, validation, and atomic publication; use Queues for independent work, Containers for resource-intensive tasks. Treat all uploaded files as untrusted; impose CPU, memory, time and disk budgets.
- Never overwrite immutable published outputs. Use idempotency keys and revision checks, retry transient failures safely, and emit observability events. Preserve last-good published revision when a new one fails.

## 11. UX pages and states

Build: marketing/landing, login/signup, dashboard, asset library, new experience wizard, full 3D editor, scene properties, image-to-AR conversion wizard, platform compatibility review, private device test, publishing progress, publish/share screen, public viewer, account/settings, error/unsupported pages.

Provide full visual states for empty, drag-over, upload-progress, processing, conversion failure, target-image warning, no model, missing alpha, unsupported runtime, unsupported action, image tracking scanning/acquired/lost, Scene Viewer fallback, Quick Look launch failure, publish ready, partial readiness and republish failure.

Use keyboard navigation, screen-reader labels, focus management, reduced-motion support and color-contrast checks. Do not use Tailwind or Next.js. Use CSS Modules and CSS variables.

## 12. Security and data policy

Enforce ownership per asset/experience, authenticated draft APIs, expiring upload authorization, verified MIME and magic bytes, model parsing limits, image decompression limits, URL-scheme allowlists, safe HTML/text rendering and CSP. Do not execute user HTML/JavaScript. Run converters isolated with no unnecessary network access. Never expose private raw asset URLs through public APIs. Do not retain camera video or recognized environmental imagery as analytics. Support deletion and artifact cleanup. Implement rate limiting and operational alerts.

## 13. Acceptance tests

**A. Image-target poster:** PNG/JPG target at 20 cm; upload GLB model; position with proper scale; add label and primary external link; iOS image-anchored USDZ detects printed target; Android experimental WebXR tracks target if enabled and supported; incompatible devices show an honest fallback.

**B. Floor product:** upload GLB and optional alpha-PNG logo rendered as geometry; publish USDZ iOS and **composed GLB Android**; Android opens **Scene Viewer** in `ar_preferred` mode; external link works where supported. No WebXR launched.

**C. Wall art:** place image-as-AR object on vertical plane, with title and link; iOS vertical USD anchoring; Android Scene Viewer launched with `enable_vertical_placement=true`; verify on a supported real device. No tracking image required.

**D. Transparent-image generator:** upload a PNG with transparent outer region, a completely transparent interior hole and partially transparent antialiased edges. Generate GLB and USDZ, confirm dimensions, no opaque backdrop, correct transparency, cutout option behavior, and independent use as a scene asset. Test `MASK` and `BLEND` in supported viewers; verify platform visual differences.

**E. Multiple elements:** compose two models, logo, static information card, primary CTA and two additional links. Ensure Scene Viewer receives a single compiled GLB and supported primary link, Quick Look receives USDZ + CTA, Android image mode receives supported WebXR interactions, and all additional links remain accessible on the landing page.

**F. Publishing:** edits create immutable revision; failed recompilation cannot break existing live experience; public URL and QR code stay stable; statuses match verified processing results.

**G. Unsupported browser/device:** clear compatibility and 3D preview, no simulation described as AR.

Automate unit/schema/asset tests, API tests, converter golden tests, security tests and browser UI tests. Maintain a separate physical-device matrix for iOS Quick Look, Android Scene Viewer and experimental Chrome WebXR. Do not claim to have run device tests without evidence.

## 14. Delivery sequence

1. **Prove runtimes:** validate Apple image/floor/wall anchoring, Android image tracking, Android Scene Viewer floor+wall (including vertical flag), transparent image GLB/USDZ in both native viewers, Quick Look and Scene Viewer primary links, and conversion-container feasibility.
2. **Foundation:** Vite/React/CSS Modules; Hono Worker; Drizzle/PostgreSQL/Hyperdrive; R2; auth; dashboard.
3. **Image-to-AR:** PNG alpha pipeline, output dimensions, GLB/USDZ generator, provenance, viewer validation.
4. **Scene editor:** scene graph, placement modes, visual transforms, element palette, actions, autosave and undo/redo.
5. **Platform compilers:** iOS USDZ, Android image WebXR, Android floor/wall Scene Viewer GLB.
6. **Publishing:** Workflows, idempotent jobs, availability and compatibility reports, private test links, public URL and QR code.
7. **Hardening:** device regression tests, performance, accessibility, security, observability and docs.

Each phase requires working code, tests, a concise change log, and documented constraints. Do not mark a task complete solely because an interface renders.

## 15. Required persistent AI documentation

Create and maintain these project-root Markdown files:

- `AGENTS.md`: authoritative shared instructions for AI/code agents.
- `AGENT.md`: compatibility pointer for tools expecting the singular name.
- `CLAUDE.md`: Claude-specific start-of-session and verification process referencing `AGENTS.md`.
- `DESIGN.md`: product experience, design tokens, interaction and accessibility rules.
- `ARCHITECTURE.md`: system boundaries, Cloudflare infrastructure and processing contracts.
- `PLATFORM_ROUTING.md`: the exact platform × placement routing and launch behavior.
- `CAPABILITIES.md`: source-of-truth features and fallbacks by runtime.
- `IMAGE_TO_AR.md`: display-image conversion and alpha implementation requirements.
- `DATA_MODEL.md`: discriminated schemas, scene graph and derivative provenance.
- `TESTING.md`: acceptance tests, test rigs and device-verification evidence.
- `SECURITY.md`: upload, processing and publishing threat model.
- `ROADMAP.md`: phases, stage gates and release criteria.
- `TASKS.md`: actionable backlog with status and owners.
- `DECISIONS.md`: append-only architectural decision record.
- `PROGRESS.md`: status, last verified build, known blockers and next steps.
- `CHANGELOG.md`: user-facing and technical changes by revision.
- `README.md`: onboarding and navigation of all above.

At the beginning of each AI coding session: read `AGENTS.md`, `PROGRESS.md`, `TASKS.md`, `DECISIONS.md`, `PLATFORM_ROUTING.md`, `CAPABILITIES.md` and the relevant subsystem document. At the end: run relevant checks, record actual test results, update `PROGRESS.md`/`TASKS.md`/`CHANGELOG.md`, and append a `DECISIONS.md` record for meaningful architectural changes. Do not rewrite past decision history.

## 16. Non-negotiable build rules

- No Next.js or Tailwind.
- No fake AR or tracking.
- Android image = experimental native WebXR only.
- Android floor/wall = **Scene Viewer only**; wall uses `enable_vertical_placement=true`.
- iOS image/floor/wall = appropriately anchored **USDZ Quick Look**.
- Separate tracking references from display images.
- **Image to AR** must output **GLB + USDZ** and preserve PNG alpha.
- Native Quick Look and Scene Viewer do not gain custom HTML/3D clickable hotspots just because the editor exposes those interactions.
- Compile one complete remote GLB for Scene Viewer instead of relying on browser-only scene composition.
- One canonical scene schema, platform-specific compilers, clear compatibility/fallbacks.
- Workload isolation, immutable publication and honest runtime/device test status.

## 17. Reference documents

- Google Scene Viewer: https://developers.google.com/ar/develop/scene-viewer
- Apple AR anchoring: https://developer.apple.com/documentation/usd/preliminary-anchoringapi
- Apple image physical width: https://developer.apple.com/documentation/usd/physicalwidth
- Apple Quick Look actions: https://developer.apple.com/documentation/arkit/adding-an-apple-pay-button-or-a-custom-action-in-ar-quick-look
- Apple USD content: https://developer.apple.com/documentation/usd/creating-usd-files-for-apple-devices
- WebXR image tracking draft: https://immersive-web.github.io/image-tracking/
- glTF material alpha: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
- OpenUSD Preview Surface: https://openusd.org/dev/spec_usdpreviewsurface.html
- Cloudflare Vite plugin: https://developers.cloudflare.com/workers/vite-plugin/
- Cloudflare Containers: https://developers.cloudflare.com/containers/
- Cloudflare Workflows: https://developers.cloudflare.com/workflows/
- Cloudflare Hyperdrive: https://developers.cloudflare.com/hyperdrive/

## 18. Execution instruction

Start by reading all persistent documentation, identifying contradictions, and implementing the **runtime proof-of-concept stage** before the polished editor. Build actual source code, migrations, test suites, image-to-AR converters, launch links and deployment configuration. Keep a traceable task backlog. Never report conversion, tracking or device compatibility as complete without a corresponding reproducible verification result.

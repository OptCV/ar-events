# DESIGN.md — Creator UX and Design System

## Product outcome

Turn complex AR publishing into a visual, approachable workflow. The user should not need to learn USD, image tracking, glTF internals, WebXR flags or Android intent URIs.

**Creator journey:** Create → Placement (Image / Floor / Wall) → Assets → Scene → Interactions → Appearance → Preview & Compatibility → Publish.

## Information architecture

- Dashboard: search, filters, status, copy URL, duplicate, edit, unpublish.
- Asset library: upload/inspect/convert; differentiate `Tracking Image` versus `Image as AR Object`.
- Wizard: persistent draft, stepper navigation, clear validation and autosave.
- Editor: asset/tree panel left; 3D viewport center; inspector right; responsive bottom sheets on mobile.
- Preview: ordinary 3D simulation, *distinctly labeled* from actual on-device AR tests.
- Publish: platform matrix, warnings, generation progress, one URL, QR, test links.
- Public page: title/thumbnail, support explanation, Start AR, fallback 3D preview, additional CTAs.

## Visual style

Quiet, premium, production-oriented. Spacious canvas, clear action hierarchy, no overdecorated gradients. Implement CSS Modules + CSS custom properties; no Tailwind.

Suggested tokens (tunable):

```css
:root {
  --ui-bg: #f7f8fa;
  --ui-surface: #ffffff;
  --ui-surface-muted: #eef1f5;
  --ui-text: #17202a;
  --ui-text-secondary: #596676;
  --ui-border: #dce2e8;
  --ui-accent: #215cc5;
  --ui-accent-contrast: #ffffff;
  --ui-danger: #b82f39;
  --ui-warning: #95610b;
  --ui-radius-sm: 6px;
  --ui-radius-md: 10px;
  --ui-radius-lg: 16px;
  --ui-space-1: 4px;
  --ui-space-2: 8px;
  --ui-space-3: 12px;
  --ui-space-4: 16px;
  --ui-space-6: 24px;
  --ui-space-8: 32px;
}
```

Define type scale and responsive tokens centrally. Support dark mode later unless requested for MVP.

## Editor interaction principles

- Placement mode selector always visible; changing mode triggers a non-destructive placement migration review.
- Use scene object layers: model, image-card, text, primitive, marker, CTA/action overlay.
- Drag to move only with selected tool; orbit camera must not accidentally manipulate objects.
- Gizmos for move/rotate/scale; numerical transforms in meters/degrees (quaternions stored internally).
- Use lock, hide, duplicate, align, snap, fit-to-target, ground-align and wall-flush.
- Offer reference-target preview sized to physical dimensions and a printable target sheet.
- Show imported model bounds, physical width/height, polygon and texture budget.
- Offer object selection breadcrumbs and empty state guidance.

## Image-to-AR user flow

Upload PNG/JPG/WebP → inspect transparency → preview checkerboard → select physical width → Flat / Cutout / Extrusion option → choose alpha policy (auto / mask / blend) → choose double-sided behavior → Generate GLB & USDZ → inspect preview → Add to scene or Download.

The initial version can implement flat only; hide or label cutout/extrude as unavailable rather than acting functional. The conversion must preserve semi-transparent pixels where allowed.

## Interaction design and compatibility

In the inspector, display a small runtime indicator beside an action: `WebXR`, `Quick Look CTA`, `Scene Viewer link`, `Landing page`. Explain limitations inline.

For native Scene Viewer and Quick Look, the user may customize a **single primary native CTA** where supported; extra links display on landing page. In WebXR image mode, on-screen actions can be customized as HTML overlay where supported.

The capability report is a mandatory pre-publish step. Do not silently remove or pretend a custom 3D button works in native viewers.

## Accessibility

Keyboard navigation, semantic labeling, visible focus, undo/redo affordances, descriptive upload errors, 44px-equivalent touch targets where practical, color contrast, reduced motion, mobile safe-area awareness and screen-reader announcements for processing states.

## User messages

- Experimental tracking: “Image tracking requires a supported Android Chrome configuration. You can still preview this experience in 3D.”
- Unsupported action: “This hotspot is interactive in Android image-tracking mode. On iOS and Android Scene Viewer, its link appears on the experience page.”
- Transparent image: “Transparent pixels will remain see-through in the AR object. Some materials may render differently between devices.”
- Failure: show precise failed step, retry button, and actionable detail; never call a failed conversion published.

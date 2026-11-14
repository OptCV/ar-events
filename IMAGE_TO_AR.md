# IMAGE_TO_AR.md — 2D Image to GLB + USDZ Feature

## Purpose and conceptual boundary

Let users convert a **display image** into an AR-viewable 2D or 2.5D object. The default result is a textured, dimensioned rectangular plane with RGBA transparency; **it is not automatic 3D reconstruction of the image subject**. This is independent of *tracking target images*, which are used solely to recognize a physical visual reference.

## User flow

1. Upload PNG/JPG/WebP. Inspect dimensions, size, alpha channel and color profile.
2. Preview on transparent checkerboard and on dark/light backgrounds; highlight visible alpha edges.
3. Set physical width in cm/in; derive height from pixel aspect ratio. Optional explicit height with aspect-lock toggle.
4. Choose Flat Plane (MVP), Alpha Cutout (optional), or Extruded Silhouette (future); choose one-sided or double-sided.
5. Choose alpha treatment: Auto / `MASK` + threshold / `BLEND` for partial transparency. Auto should inspect alpha distribution and prefer BLEND for fractional alpha, MASK for sharp cutouts when appropriate.
6. Position pivot (center, bottom-center), orientation (stand-up wall / floor-facing) and optional backing/material (explicitly off by default for transparent PNG).
7. Generate both `image-object.glb` and `image-object.usdz`, inspect in preview, save as derived assets with provenance. Optionally add to current experience.

## Flat GLB generation

- Quad (two triangles) with correct image-aspect dimensions in meters.
- UVs maintain original orientation, avoiding vertical flipping.
- RGBA baseColor texture (PNG when alpha exists). If original is JPEG, fully opaque material is allowed.
- `alphaMode=BLEND` for fractional alpha; `MASK` + `alphaCutoff` for binary cutouts; never `OPAQUE` when nontrivial alpha exists.
- `doubleSided=true` only where user selects; use compatibility-tested material feature set for Scene Viewer.
- Embed or package texture in one GLB. Test pixel sampling, alpha halos, mipmapping, premultiplied-alpha edge behavior and color space.

## USDZ generation

- Match quad size, UV orientation and pivot to GLB.
- Use compatible USD material: `UsdPreviewSurface` with color texture and a **verified alpha/opacity connection** (e.g. alpha output of `UsdUVTexture` to opacity input).
- Use mask/cutout threshold only when intended, avoid unintended specular visibility at 0 opacity; test actual target renderer.
- Package PNG texture (or supported equivalent) inside USDZ via validated USD packaging.
- Verify transparency on actual Quick Look, not solely in a desktop USD viewer.
- No opaque backing unless creator opts in; no texture premultiplication mistakes.

## Geometric hole option

Transparency does not modify collision or mesh silhouette. A clear hole in the PNG will be visibly clear on the flat plane but the mesh remains a rectangle. `Alpha Cutout` can triangulate opaque regions and remove transparent internal regions. An `Extruded Silhouette` can add side walls and thickness. These modes require polygon contour tracing, simplification, hole winding, mesh topology tests, UV preservation, self-intersection checks, and feature-specific performance limits. Hide them until implemented rather than pretending flat alpha is extruded geometry.

## Derived asset metadata

Store sourceAssetId, content hash, converterVersion, settings (`widthMeters`, `alphaMode`, `cutoff`, `doubleSided`, `pivot`, `shapeMode`, `thicknessMeters`), generatedGLBAssetId, generatedUSDZAssetId, full diagnostics, physical bounds and test status. Recompute derived outputs only when input bytes or settings change.

## Golden fixtures

1. Opaque JPEG photo.
2. PNG transparent border around opaque logo.
3. PNG with an internal transparent hole.
4. PNG with alpha values 0, 0.2, 0.5, 0.8, 1 and antialiased edges.
5. PNG with nearly transparent dark edge pixels to catch halos.
6. Very tall image, very wide image, non-power-of-two dimensions.
7. Image with correct/incorrect EXIF orientation and color profile.

## Acceptance

Both files validate, open in intended native viewers, share physical dimensions within tolerance, preserve visible alpha including holes and semitransparency to renderer-supported fidelity, and never introduce an unwanted white/black rectangle. The generated asset must be reusable in image, wall and floor experiences, including Android Scene Viewer floor/wall.

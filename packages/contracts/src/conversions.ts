import { z } from 'zod';
import { ImageToArSettings } from '@ar-creator/schema';

/**
 * Image-to-AR conversion contracts (Phase 2 Milestone 1, ADR-023). A conversion turns one validated display image
 * into a flat image object: `image-object.glb` (built in the Worker) and `image-object.usdz` (built by the OpenUSD
 * converter in a Cloudflare Container). Same source bytes + settings + converter versions → the same outputs,
 * reused instead of recomputed (IMAGE_TO_AR.md "Derived asset metadata").
 */

/** Version of the Python USD converter this Worker expects (must equal `CONVERTER_VERSION` in image_plane.py). */
export const USD_CONVERTER_VERSION = 'usd-image-plane@0.1.0';

/** Version of the Python texture preparation (must equal `TEXTURE_CONVERTER_VERSION` in texture.py). */
export const TEXTURE_CONVERTER_VERSION = 'texture@0.1.0';

/**
 * Longest texture edge embedded in image objects (ADR-025). Larger images are downscaled once, so GLB and USDZ stay
 * within common mobile AR texture budgets. Conservative choice; to be confirmed on devices.
 */
export const TEXTURE_MAX_EDGE = 2048;

/** What was done to the uploaded image to make the embedded texture (empty: the original bytes are embedded). */
export const TEXTURE_CHANGES = ['converted', 'rotated', 'resized'] as const;
export const TextureInfo = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  changes: z.array(z.enum(TEXTURE_CHANGES)),
});
export type TextureInfo = z.infer<typeof TextureInfo>;

/** Settings accepted for a conversion. `shapeMode` is flat only; cutout/extruded modes stay hidden until built. */
export const ImageObjectSettings = ImageToArSettings;
export type ImageObjectSettings = z.infer<typeof ImageObjectSettings>;
export type ImageObjectSettingsInput = z.input<typeof ImageObjectSettings>;

export const CreateImageObjectInput = z.object({ settings: ImageObjectSettings });
export type CreateImageObjectInput = z.input<typeof CreateImageObjectInput>;

export const CONVERSION_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const ConversionState = z.enum(CONVERSION_STATES);

/** Why a conversion failed (`ConversionSummary.error.code`). */
export const CONVERSION_ERRORS = [
  'source_unavailable', // the source asset is gone, changed, or no longer validated
  'unsupported_image', // e.g. a JPEG with EXIF rotation (normalisation pending, ADR-009)
  'invalid_settings', // e.g. OPAQUE requested for an image with transparency
  'converter_failed', // the USD converter refused or failed validation
  'converter_unavailable', // the Container could not be reached (retried before giving up)
  'output_mismatch', // GLB and USDZ disagree on dimensions or alpha mode
  'internal',
] as const;
export type ConversionErrorCode = (typeof CONVERSION_ERRORS)[number];

export const DerivativeOutput = z.object({
  id: z.string(),
  format: z.enum(['glb', 'usdz']),
  state: z.enum(['pending', 'ready', 'failed']),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  converterVersion: z.string(),
  /** Short-lived signed URL (ready outputs only). Works without cookies, for Scene Viewer and Quick Look. */
  contentUrl: z.string().nullable(),
  contentUrlExpiresAt: z.string().nullable(),
  /** Suggested download name, e.g. `poster-image-object.usdz`. */
  downloadName: z.string(),
});
export type DerivativeOutput = z.infer<typeof DerivativeOutput>;

export const ConversionSummary = z.object({
  id: z.string(),
  sourceAssetId: z.string(),
  state: ConversionState,
  settings: ImageObjectSettings,
  /** The alpha mode actually used (`auto` resolved from the pixels), once known. */
  resolvedAlphaMode: z.enum(['OPAQUE', 'MASK', 'BLEND']).nullable(),
  widthMeters: z.number().nullable(),
  heightMeters: z.number().nullable(),
  /** Alpha distribution of the source (PNG), when analysed. */
  alpha: z
    .object({ transparentPixels: z.number().int(), fractionalPixels: z.number().int(), pixels: z.number().int() })
    .nullable(),
  /** The texture embedded in both files, once known. */
  texture: TextureInfo.nullable(),
  outputs: z.object({ glb: DerivativeOutput.nullable(), usdz: DerivativeOutput.nullable() }),
  error: z.object({ code: z.enum(CONVERSION_ERRORS), message: z.string() }).nullable(),
  attempt: z.number().int(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type ConversionSummary = z.infer<typeof ConversionSummary>;

export const ConversionListResponse = z.object({ conversions: z.array(ConversionSummary) });
export type ConversionListResponse = z.infer<typeof ConversionListResponse>;

/** Per-user cap on conversions that are queued or running at once. */
export const MAX_ACTIVE_CONVERSIONS = 3;

/**
 * A finished image object that can be placed in an experience (Phase 2 Milestone 7). Its `id` is the GLB
 * derivative id, which scene `image-object` nodes reference as `derivativeId`; the USDZ is the matching pair.
 */
export const ImageObjectSummary = z.object({
  id: z.string(),
  conversionId: z.string(),
  sourceAssetId: z.string(),
  sourceFilename: z.string().nullable(),
  /** Signed URL of the source image, for thumbnails. */
  previewUrl: z.string().nullable(),
  settings: ImageObjectSettings,
  resolvedAlphaMode: z.enum(['OPAQUE', 'MASK', 'BLEND']).nullable(),
  widthMeters: z.number().nullable(),
  heightMeters: z.number().nullable(),
  glb: DerivativeOutput,
  usdz: DerivativeOutput,
  createdAt: z.string(),
});
export type ImageObjectSummary = z.infer<typeof ImageObjectSummary>;

export const ImageObjectListResponse = z.object({ imageObjects: z.array(ImageObjectSummary) });
export type ImageObjectListResponse = z.infer<typeof ImageObjectListResponse>;

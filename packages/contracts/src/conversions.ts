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

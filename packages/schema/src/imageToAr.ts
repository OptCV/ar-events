import { z } from 'zod';

/** Settings for Image to AR Object (2D/2.5D). IMAGE_TO_AR.md. MVP implements `flat` only. */
export const ImageToArSettings = z.object({
  widthMeters: z.number().min(0.01).max(20),
  shapeMode: z.literal('flat'),
  alphaMode: z.enum(['auto', 'MASK', 'BLEND', 'OPAQUE']),
  alphaCutoff: z.number().min(0).max(1).default(0.5),
  doubleSided: z.boolean().default(false),
  pivot: z.enum(['center', 'bottom-center']).default('center'),
  /** `upright`: card in XY plane facing +Z. `flat`: card in XZ plane facing +Y (lying on floor/target). */
  orientation: z.enum(['upright', 'flat']).default('upright'),
});
export type ImageToArSettings = z.infer<typeof ImageToArSettings>;
export type ImageToArSettingsInput = z.input<typeof ImageToArSettings>;

export type ResolvedAlphaMode = 'OPAQUE' | 'MASK' | 'BLEND';

export const CONVERTER_VERSION = 'image-to-ar@0.1.0';

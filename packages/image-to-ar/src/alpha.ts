import type { ImageToArSettings, ResolvedAlphaMode } from '@ar-creator/schema';

export interface AlphaStats {
  pixels: number;
  transparent: number; // alpha == 0
  fractional: number; // 0 < alpha < 255
  opaque: number; // alpha == 255
  minAlpha: number;
  maxAlpha: number;
}

/** Analyze straight (non-premultiplied) RGBA8 pixels. */
export function analyzeAlpha(rgba: Uint8Array, width: number, height: number): AlphaStats {
  const pixels = width * height;
  if (rgba.length !== pixels * 4) throw new Error(`expected ${pixels * 4} RGBA bytes, got ${rgba.length}`);
  let transparent = 0;
  let opaque = 0;
  let minAlpha = 255;
  let maxAlpha = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i]!;
    if (a === 0) transparent++;
    else if (a === 255) opaque++;
    if (a < minAlpha) minAlpha = a;
    if (a > maxAlpha) maxAlpha = a;
  }
  return { pixels, transparent, opaque, fractional: pixels - transparent - opaque, minAlpha, maxAlpha };
}

/**
 * Fraction of fractional-alpha pixels above which Auto picks BLEND. Below it (e.g. a handful of stray
 * pixels) MASK gives sharper sorting-free results. Antialiased logos typically exceed this.
 */
export const AUTO_BLEND_FRACTIONAL_RATIO = 0.001;

/**
 * Auto policy (IMAGE_TO_AR.md): no alpha → OPAQUE; meaningful fractional alpha → BLEND; binary → MASK.
 * Explicit OPAQUE is refused when the image actually contains transparency.
 */
export function resolveAlphaMode(requested: ImageToArSettings['alphaMode'], stats: AlphaStats | null): ResolvedAlphaMode {
  const hasAlpha = stats !== null && stats.minAlpha < 255;
  if (requested === 'OPAQUE') {
    if (hasAlpha) throw new Error('OPAQUE alpha mode refused: image contains transparent pixels');
    return 'OPAQUE';
  }
  if (requested === 'MASK' || requested === 'BLEND') return hasAlpha ? requested : 'OPAQUE';
  if (!hasAlpha) return 'OPAQUE';
  return stats.fractional / stats.pixels > AUTO_BLEND_FRACTIONAL_RATIO ? 'BLEND' : 'MASK';
}

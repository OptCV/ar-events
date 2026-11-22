import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImageFormatError, isWebp, readImageInfo, webpRiffSize } from './index.ts';

const FIX = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures');
const load = (p: string) => new Uint8Array(readFileSync(join(FIX, p)));

describe('WebP headers (ADR-025)', () => {
  it('reads dimensions and alpha from lossless (VP8L/VP8X) and lossy (VP8) files, matching their sources', () => {
    for (const [webp, src] of [
      ['normalize/logo_alpha_lossless.webp', 'images/logo_transparent_border.png'],
      ['normalize/disc_soft_alpha.webp', 'images/aa_disc_dark_fringe.png'],
      ['normalize/photo_lossy.webp', 'images/opaque_photo.jpg'],
    ] as const) {
      const w = load(webp);
      const s = readImageInfo(load(src));
      expect(isWebp(w), webp).toBe(true);
      expect(webpRiffSize(w), webp).toBe(w.length);
      expect(readImageInfo(w), webp).toEqual({ mime: 'image/webp', width: s.width, height: s.height, mayHaveAlpha: !webp.includes('photo') });
    }
  });

  it('refuses animated and malformed WebP', () => {
    expect(() => readImageInfo(load('normalize/animated.webp'))).toThrow(/animated WebP/);
    const w = load('normalize/photo_lossy.webp').slice();
    w.set(new TextEncoder().encode('XXXX'), 12);
    expect(() => readImageInfo(w)).toThrow(ImageFormatError);
    expect(() => readImageInfo(load('normalize/photo_lossy.webp').subarray(0, 20))).toThrow(/truncated/);
    expect(isWebp(load('images/opaque_photo.jpg'))).toBe(false);
  });
});

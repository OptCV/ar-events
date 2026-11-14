/** Header-only image inspection (no decode). Validates magic bytes rather than trusting MIME/filename. */
export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  /** True when the container can carry alpha (PNG color type 4/6, or a tRNS chunk). JPEG: false. */
  mayHaveAlpha: boolean;
}

export class ImageFormatError extends Error {
  override name = 'ImageFormatError';
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Decompression-bomb guard: refuse anything above this pixel count before decoding. */
export const MAX_PIXELS = 8192 * 8192;
export const MAX_EDGE = 8192;

export function readImageInfo(bytes: Uint8Array): ImageInfo {
  const info = PNG_SIG.every((b, i) => bytes[i] === b) ? readPng(bytes) : bytes[0] === 0xff && bytes[1] === 0xd8 ? readJpeg(bytes) : null;
  if (!info) throw new ImageFormatError('unsupported image signature (PNG and JPEG are supported; WebP pending)');
  if (info.width < 1 || info.height < 1) throw new ImageFormatError('image has zero dimension');
  if (info.width > MAX_EDGE || info.height > MAX_EDGE || info.width * info.height > MAX_PIXELS) {
    throw new ImageFormatError(`image ${info.width}x${info.height} exceeds limits`);
  }
  return info;
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function readPng(b: Uint8Array): ImageInfo {
  if (b.length < 33 || String.fromCharCode(...b.subarray(12, 16)) !== 'IHDR') throw new ImageFormatError('PNG missing IHDR');
  const width = u32(b, 16);
  const height = u32(b, 20);
  const colorType = b[25]!;
  let mayHaveAlpha = colorType === 4 || colorType === 6;
  // Scan chunks for tRNS (palette/greyscale/RGB transparency) until IDAT.
  let o = 8;
  while (!mayHaveAlpha && o + 8 <= b.length) {
    const len = u32(b, o);
    const type = String.fromCharCode(...b.subarray(o + 4, o + 8));
    if (type === 'tRNS') mayHaveAlpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    o += 12 + len;
  }
  return { mime: 'image/png', width, height, mayHaveAlpha };
}

function readJpeg(b: Uint8Array): ImageInfo {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) throw new ImageFormatError('corrupt JPEG marker stream');
    const marker = b[o + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    // SOF0..SOF15 excluding DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[o + 5]! << 8) | b[o + 6]!;
      const width = (b[o + 7]! << 8) | b[o + 8]!;
      return { mime: 'image/jpeg', width, height, mayHaveAlpha: false };
    }
    o += 2 + len;
  }
  throw new ImageFormatError('JPEG has no SOF marker');
}

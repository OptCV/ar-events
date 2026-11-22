/** Header-only image inspection (no decode). Validates magic bytes rather than trusting MIME/filename. */
export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  /** True when the container can carry alpha (PNG color type 4/6 or tRNS; WebP alpha flag/bit). JPEG: false. */
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
  const info = PNG_SIG.every((b, i) => bytes[i] === b) ? readPng(bytes) : bytes[0] === 0xff && bytes[1] === 0xd8 ? readJpeg(bytes) : isWebp(bytes) ? readWebp(bytes) : null;
  if (!info) throw new ImageFormatError('unsupported image signature (PNG, JPEG and WebP are supported)');
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

/**
 * EXIF orientation of a JPEG (1–8), or 1 when absent/unreadable. ADR-009: only orientation 1 may be embedded
 * as-is; other values need a lossless normalisation step that does not exist yet, so conversion refuses them.
 */
export function jpegOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff) {
    const marker = b[o + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end: no more metadata
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    if (len < 2 || o + 2 + len > b.length) break;
    if (marker === 0xe1 && len >= 16 && String.fromCharCode(...b.subarray(o + 4, o + 10)) === 'Exif\0\0') {
      return exifOrientation(b.subarray(o + 10, o + 2 + len));
    }
    o += 2 + len;
  }
  return 1;
}

function exifOrientation(t: Uint8Array): number {
  if (t.length < 8) return 1;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return 1;
  const u16 = (o: number) => (le ? t[o]! | (t[o + 1]! << 8) : (t[o]! << 8) | t[o + 1]!);
  const u32le = (o: number) => (le ? (t[o]! | (t[o + 1]! << 8) | (t[o + 2]! << 16) | (t[o + 3]! << 24)) >>> 0 : ((t[o]! << 24) | (t[o + 1]! << 16) | (t[o + 2]! << 8) | t[o + 3]!) >>> 0);
  const ifd = u32le(4);
  if (ifd + 2 > t.length) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return 1;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

/** RIFF....WEBP container (https://developers.google.com/speed/webp/docs/riff_container). */
export function isWebp(b: Uint8Array): boolean {
  return b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP';
}

/** Declared RIFF payload size + 8: must equal the file size for a complete file. */
export function webpRiffSize(b: Uint8Array): number {
  return ((b[4]! | (b[5]! << 8) | (b[6]! << 16) | (b[7]! << 24)) >>> 0) + 8;
}

function readWebp(b: Uint8Array): ImageInfo {
  if (b.length < 30) throw new ImageFormatError('WebP header is truncated');
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') {
    const flags = b[20]!;
    if (flags & 0x02) throw new ImageFormatError('animated WebP is not supported');
    return { mime: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, mayHaveAlpha: (flags & 0x10) !== 0 };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) throw new ImageFormatError('corrupt lossless WebP header');
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, mayHaveAlpha: ((bits >>> 28) & 1) === 1 };
  }
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) throw new ImageFormatError('corrupt lossy WebP header');
    return { mime: 'image/webp', width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff, mayHaveAlpha: false };
  }
  throw new ImageFormatError('unknown WebP format');
}

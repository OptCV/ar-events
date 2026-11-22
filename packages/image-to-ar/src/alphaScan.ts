import type { AlphaStats } from './alpha.ts';
import { ImageFormatError, readImageInfo } from './imageInfo.ts';

/**
 * Streaming PNG alpha statistics (Phase 2, ADR-023). Produces the same `AlphaStats` as `analyzeAlpha` on a
 * fully decoded RGBA8 bitmap, but holds only two scanlines at a time, so an 8192 × 8192 image fits in a
 * Worker's 128 MB. Statistics are position-independent, so Adam7 interlacing is handled pass by pass.
 *
 * Bomb and corruption guards: dimensions are checked from the header first (`readImageInfo`); the inflated
 * stream must be exactly the size the header implies (more → refused while inflating, less → corrupt).
 * Uses the platform `DecompressionStream('deflate')` (zlib format), available in workerd and Node ≥ 18.
 */

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

export async function scanPngAlpha(png: Uint8Array): Promise<AlphaStats> {
  const info = readImageInfo(png); // signature + dimension limits
  if (info.mime !== 'image/png') throw new ImageFormatError('not a PNG');

  // ---- chunks
  let header: Header | null = null;
  let palette = 0;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let o = 8;
  let ended = false;
  while (o + 12 <= png.length) {
    const len = u32(png, o);
    const type = String.fromCharCode(png[o + 4]!, png[o + 5]!, png[o + 6]!, png[o + 7]!);
    if (o + 12 + len > png.length) throw new ImageFormatError(`PNG chunk ${type} is truncated`);
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      header = { width: u32(data, 0), height: u32(data, 4), bitDepth: data[8]!, colorType: data[9]!, interlace: data[12]! };
    } else if (type === 'PLTE') palette = len / 3;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') {
      ended = true;
      break;
    }
    o += 12 + len;
  }
  if (!header) throw new ImageFormatError('PNG missing IHDR');
  if (!ended) throw new ImageFormatError('PNG has no IEND (truncated)');
  if (!idat.length) throw new ImageFormatError('PNG has no image data');
  const { width, height, bitDepth, colorType, interlace } = header;
  if (!DEPTHS[colorType]?.includes(bitDepth)) throw new ImageFormatError(`unsupported PNG color type ${colorType} / bit depth ${bitDepth}`);
  if (interlace > 1) throw new ImageFormatError('unknown PNG interlace method');
  if (colorType === 3 && !palette) throw new ImageFormatError('palette PNG without PLTE');

  const pixels = width * height;
  const hasAlpha = colorType === 4 || colorType === 6 || (trns !== null && trns.length > 0);
  if (!hasAlpha) return { pixels, transparent: 0, fractional: 0, opaque: pixels, minAlpha: 255, maxAlpha: 255 };

  // ---- passes and expected inflated size
  const channels = CHANNELS[colorType]!;
  const bitsPerPixel = channels * bitDepth;
  const filterBpp = Math.max(1, bitsPerPixel >> 3);
  const passes = (interlace ? ADAM7 : [[0, 0, 1, 1] as const]).map(([xs, ys, dx, dy]) => {
    const w = width > xs ? Math.ceil((width - xs) / dx) : 0;
    const h = height > ys ? Math.ceil((height - ys) / dy) : 0;
    return { w, h, rowBytes: Math.ceil((w * bitsPerPixel) / 8) };
  }).filter((p) => p.w > 0 && p.h > 0);
  const expected = passes.reduce((n, p) => n + p.h * (p.rowBytes + 1), 0);

  // ---- per-pixel alpha classification
  const stats = { transparent: 0, opaque: 0, minAlpha: 255, maxAlpha: 0 };
  const count8 = (a: number) => {
    if (a === 0) stats.transparent++;
    else if (a === 255) stats.opaque++;
    if (a < stats.minAlpha) stats.minAlpha = a;
    if (a > stats.maxAlpha) stats.maxAlpha = a;
  };
  /** 16-bit alpha: exact 0 / 65535 decide transparent / opaque; fractional values stay in 1..254 when reduced to 8 bits. */
  const count16 = (a: number) => count8(a === 0 ? 0 : a === 65535 ? 255 : Math.min(254, Math.max(1, a >> 8)));
  const trnsKey = (i: number) => (trns && trns.length >= i * 2 + 2 ? (trns[i * 2]! << 8) | trns[i * 2 + 1]! : -1);
  const grayKey = colorType === 0 ? trnsKey(0) : -1;
  const rgbKey = colorType === 2 ? [trnsKey(0), trnsKey(1), trnsKey(2)] : null;

  const classifyRow = (row: Uint8Array, w: number) => {
    switch (colorType) {
      case 6:
        if (bitDepth === 8) for (let x = 0; x < w; x++) count8(row[x * 4 + 3]!);
        else for (let x = 0; x < w; x++) count16((row[x * 8 + 6]! << 8) | row[x * 8 + 7]!);
        return;
      case 4:
        if (bitDepth === 8) for (let x = 0; x < w; x++) count8(row[x * 2 + 1]!);
        else for (let x = 0; x < w; x++) count16((row[x * 4 + 2]! << 8) | row[x * 4 + 3]!);
        return;
      case 3:
        for (let x = 0; x < w; x++) {
          const idx = sample(row, x, bitDepth);
          if (idx >= palette) throw new ImageFormatError('palette index out of range');
          count8(idx < trns!.length ? trns![idx]! : 255);
        }
        return;
      case 0:
        for (let x = 0; x < w; x++) count8(sample(row, x, bitDepth) === grayKey ? 0 : 255);
        return;
      case 2: {
        const [r, g, b] = rgbKey!;
        if (bitDepth === 8) for (let x = 0; x < w; x++) count8(row[x * 3] === r && row[x * 3 + 1] === g && row[x * 3 + 2] === b ? 0 : 255);
        else
          for (let x = 0; x < w; x++) {
            const p = x * 6;
            count8(((row[p]! << 8) | row[p + 1]!) === r && ((row[p + 2]! << 8) | row[p + 3]!) === g && ((row[p + 4]! << 8) | row[p + 5]!) === b ? 0 : 255);
          }
        return;
      }
    }
  };

  // ---- inflate and unfilter, one scanline at a time
  let pass = 0;
  let rowInPass = 0;
  let cur = new Uint8Array(passes[0]!.rowBytes + 1);
  let prev = new Uint8Array(passes[0]!.rowBytes + 1);
  let fill = 0;
  let total = 0;

  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const feeding = (async () => {
    for (const part of idat) await writer.write(part as Uint8Array<ArrayBuffer>);
    await writer.close();
  })().catch(() => undefined); // errors surface through the reader
  const reader = ds.readable.getReader();
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new ImageFormatError('PNG image data is corrupt');
      }
      if (chunk.done) break;
      const bytes = chunk.value;
      total += bytes.length;
      if (total > expected) throw new ImageFormatError('PNG image data is larger than its header allows');
      let i = 0;
      while (i < bytes.length) {
        const need = cur.length - fill;
        const take = Math.min(need, bytes.length - i);
        cur.set(bytes.subarray(i, i + take), fill);
        fill += take;
        i += take;
        if (fill < cur.length) break;
        const p = passes[pass]!;
        unfilter(cur, prev, filterBpp);
        classifyRow(cur.subarray(1), p.w);
        [prev, cur] = [cur, prev];
        fill = 0;
        if (++rowInPass === p.h) {
          rowInPass = 0;
          pass++;
          if (pass < passes.length) {
            cur = new Uint8Array(passes[pass]!.rowBytes + 1);
            prev = new Uint8Array(passes[pass]!.rowBytes + 1);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
    await feeding;
  }
  if (total !== expected) throw new ImageFormatError('PNG image data is truncated');
  return { pixels, transparent: stats.transparent, opaque: stats.opaque, fractional: pixels - stats.transparent - stats.opaque, minAlpha: stats.minAlpha, maxAlpha: stats.maxAlpha };
}

function sample(row: Uint8Array, x: number, depth: number): number {
  if (depth === 8) return row[x]!;
  if (depth === 16) return (row[x * 2]! << 8) | row[x * 2 + 1]!;
  const perByte = 8 / depth;
  const byte = row[Math.floor(x / perByte)]!;
  const shift = 8 - depth * ((x % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

/** In-place PNG unfiltering of `line` (filter byte at [0]) against the previous reconstructed line. */
function unfilter(line: Uint8Array, prev: Uint8Array, bpp: number) {
  const type = line[0];
  const n = line.length;
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = 1 + bpp; i < n; i++) line[i] = (line[i]! + line[i - bpp]!) & 255;
      return;
    case 2:
      for (let i = 1; i < n; i++) line[i] = (line[i]! + prev[i]!) & 255;
      return;
    case 3:
      for (let i = 1; i < n; i++) line[i] = (line[i]! + (((i > bpp ? line[i - bpp]! : 0) + prev[i]!) >> 1)) & 255;
      return;
    case 4:
      for (let i = 1; i < n; i++) {
        const a = i > bpp ? line[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i > bpp ? prev[i - bpp]! : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      return;
    default:
      throw new ImageFormatError(`unknown PNG filter type ${type}`);
  }
}

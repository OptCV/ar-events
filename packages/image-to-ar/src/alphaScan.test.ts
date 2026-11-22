import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { ImageFormatError, analyzeAlpha, jpegOrientation, scanPngAlpha, type AlphaStats } from './index.ts';

const IMAGES = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'images');

// ---------------------------------------------------------------- tiny reference PNG encoder (tests only)
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

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

interface EncodeOpts {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  interlace?: boolean;
  /** samples for pixel (x, y) */
  pixel: (x: number, y: number) => number[];
  plte?: number;
  trns?: Uint8Array;
  seed?: number;
}

function encodePng(o: EncodeOpts): Uint8Array {
  const random = rng(o.seed ?? 7);
  const ch = CHANNELS[o.colorType]!;
  const bitsPerPixel = ch * o.bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const raw: number[] = [];
  for (const [xs, ys, dx, dy] of o.interlace ? ADAM7 : [[0, 0, 1, 1] as const]) {
    const w = o.width > xs ? Math.ceil((o.width - xs) / dx) : 0;
    const h = o.height > ys ? Math.ceil((o.height - ys) / dy) : 0;
    if (!w || !h) continue;
    const rowBytes = Math.ceil((w * bitsPerPixel) / 8);
    let prev = new Uint8Array(rowBytes);
    for (let py = 0; py < h; py++) {
      const line = new Uint8Array(rowBytes);
      let bit = 0;
      for (let px = 0; px < w; px++) {
        for (const s of o.pixel(xs + px * dx, ys + py * dy)) {
          if (o.bitDepth === 16) {
            line[bit >> 3] = s >> 8;
            line[(bit >> 3) + 1] = s & 255;
          } else if (o.bitDepth === 8) line[bit >> 3] = s;
          else line[bit >> 3]! |= s << (8 - o.bitDepth - (bit & 7));
          bit += o.bitDepth;
        }
      }
      const type = Math.floor(random() * 5);
      const out = new Uint8Array(rowBytes);
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type]!;
        out[i] = (line[i]! - pred) & 255;
      }
      raw.push(type, ...out);
      prev = line;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0);
  ihdr.writeUInt32BE(o.height, 4);
  ihdr[8] = o.bitDepth;
  ihdr[9] = o.colorType;
  ihdr[12] = o.interlace ? 1 : 0;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (o.plte) parts.push(chunk('PLTE', new Uint8Array(o.plte * 3)));
  if (o.trns) parts.push(chunk('tRNS', o.trns));
  const z = deflateSync(Buffer.from(raw));
  // Split IDAT in uneven pieces to exercise chunk boundaries.
  for (let i = 0; i < z.length; i += 97) parts.push(chunk('IDAT', z.subarray(i, i + 97)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return new Uint8Array(Buffer.concat(parts));
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function statsOf(alphas: number[]): AlphaStats {
  const transparent = alphas.filter((a) => a === 0).length;
  const opaque = alphas.filter((a) => a === 255).length;
  return { pixels: alphas.length, transparent, opaque, fractional: alphas.length - transparent - opaque, minAlpha: Math.min(...alphas), maxAlpha: Math.max(...alphas) };
}

// ---------------------------------------------------------------- tests
describe('scanPngAlpha matches a full decode on the committed fixtures', () => {
  for (const file of readdirSync(IMAGES).filter((f) => f.endsWith('.png'))) {
    it(file, async () => {
      const bytes = new Uint8Array(readFileSync(join(IMAGES, file)));
      const png = PNG.sync.read(Buffer.from(bytes));
      const reference = analyzeAlpha(new Uint8Array(png.data), png.width, png.height);
      const scanned = await scanPngAlpha(bytes);
      // Opaque-by-construction PNGs (no alpha channel, no tRNS) short-circuit without inflating.
      expect(scanned).toEqual(reference);
    });
  }
});

describe('scanPngAlpha covers every color type, bit depth, filter and interlacing', () => {
  const W = 37;
  const H = 23; // odd sizes leave partial Adam7 passes and partial bytes
  const cases: { name: string; colorType: number; bitDepth: number; px: (x: number, y: number) => { s: number[]; a: number }; plte?: number; trns?: Uint8Array }[] = [
    { name: 'RGBA8', colorType: 6, bitDepth: 8, px: (x, y) => ({ s: [x, y, 9, (x * 7 + y * 3) % 256], a: (x * 7 + y * 3) % 256 }) },
    {
      name: 'RGBA16',
      colorType: 6,
      bitDepth: 16,
      px: (x, y) => {
        const a16 = [0, 65535, 1, 65534, 300, 40000][(x + y) % 6]!;
        return { s: [x * 999, y, 0, a16], a: a16 === 0 ? 0 : a16 === 65535 ? 255 : Math.min(254, Math.max(1, a16 >> 8)) };
      },
    },
    { name: 'GA8', colorType: 4, bitDepth: 8, px: (x, y) => ({ s: [x, (x * y) % 256], a: (x * y) % 256 }) },
    { name: 'GA16', colorType: 4, bitDepth: 16, px: (x) => ({ s: [1, x % 2 ? 65535 : 0], a: x % 2 ? 255 : 0 }) },
    ...([1, 2, 4, 8] as const).map((d) => ({
      name: `palette${d}+tRNS`,
      colorType: 3,
      bitDepth: d,
      plte: 1 << d,
      trns: new Uint8Array([0, 128, 255].slice(0, Math.min(3, 1 << d))),
      px: (x: number, y: number) => {
        const idx = (x + 2 * y) % (1 << d);
        return { s: [idx], a: [0, 128, 255][idx] ?? 255 };
      },
    })),
    ...([1, 2, 4, 8, 16] as const).map((d) => ({
      name: `gray${d}+tRNS`,
      colorType: 0,
      bitDepth: d,
      trns: new Uint8Array([0, 1]),
      px: (x: number, y: number) => {
        const v = (x + y) % 3 === 0 ? 1 : 0;
        return { s: [v], a: v === 1 ? 0 : 255 };
      },
    })),
    {
      name: 'RGB8+tRNS',
      colorType: 2,
      bitDepth: 8,
      trns: new Uint8Array([0, 10, 0, 20, 0, 30]),
      px: (x) => (x % 4 === 0 ? { s: [10, 20, 30], a: 0 } : { s: [10, 20, 31], a: 255 }),
    },
    {
      name: 'RGB16+tRNS',
      colorType: 2,
      bitDepth: 16,
      trns: new Uint8Array([1, 0, 2, 0, 3, 0]),
      px: (x) => (x % 3 === 0 ? { s: [256, 512, 768], a: 0 } : { s: [256, 512, 769], a: 255 }),
    },
  ];
  for (const c of cases) {
    for (const interlace of [false, true]) {
      it(`${c.name}${interlace ? ' Adam7' : ''}`, async () => {
        const alphas: number[] = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) alphas.push(c.px(x, y).a);
        const png = encodePng({ width: W, height: H, colorType: c.colorType, bitDepth: c.bitDepth, interlace, pixel: (x, y) => c.px(x, y).s, ...(c.plte ? { plte: c.plte } : {}), ...(c.trns ? { trns: c.trns } : {}), seed: c.colorType * 31 + c.bitDepth });
        expect(await scanPngAlpha(png)).toEqual(statsOf(alphas));
      });
    }
  }

  it('1×1 and Adam7 images smaller than the first pass', async () => {
    for (const [w, h] of [[1, 1], [3, 2], [1, 9]] as const) {
      const png = encodePng({ width: w, height: h, colorType: 6, bitDepth: 8, interlace: true, pixel: (x, y) => [0, 0, 0, x === 0 && y === 0 ? 0 : 255] });
      const alphas = Array.from({ length: w * h }, (_, i) => (i === 0 ? 0 : 255));
      expect(await scanPngAlpha(png)).toEqual(statsOf(alphas));
    }
  });
});

describe('scanPngAlpha refuses malformed data', () => {
  const base = () => encodePng({ width: 16, height: 16, colorType: 6, bitDepth: 8, pixel: () => [1, 2, 3, 128] });

  it('more inflated data than the header allows (decompression bomb shape)', async () => {
    const png = encodePng({ width: 16, height: 16, colorType: 6, bitDepth: 8, pixel: () => [1, 2, 3, 4] });
    // Rewrite IHDR to claim fewer rows than the data holds (CRC is not checked by the scanner).
    png[23] = 4;
    await expect(scanPngAlpha(png)).rejects.toThrow(/larger than its header/);
  });
  it('truncated image data', async () => {
    const png = base();
    png[23] = 32; // claims 32 rows, holds 16
    await expect(scanPngAlpha(png)).rejects.toThrow(/truncated/);
  });
  it('missing IEND, corrupt deflate, bad filter', async () => {
    const png = base();
    await expect(scanPngAlpha(png.subarray(0, png.length - 12))).rejects.toThrow(ImageFormatError);
    const corrupt = base();
    const idat = Buffer.from(corrupt).indexOf('IDAT', 0, 'latin1');
    corrupt.fill(0xff, idat + 6, idat + 40);
    await expect(scanPngAlpha(corrupt)).rejects.toThrow(ImageFormatError);
  });
  it('not a PNG', async () => {
    await expect(scanPngAlpha(new Uint8Array(readFileSync(join(IMAGES, 'opaque_photo.jpg'))))).rejects.toThrow(/not a PNG/);
  });
  it('a large image stays fast (2048 × 2048 RGBA)', async () => {
    const png = new PNG({ width: 2048, height: 2048 });
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = i % 1024 === 3 ? 0 : 255;
    const bytes = new Uint8Array(PNG.sync.write(png));
    const t0 = performance.now();
    const s = await scanPngAlpha(bytes);
    expect(s.pixels).toBe(2048 * 2048);
    expect(s.transparent).toBe(2048 * 2048 / 256);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('jpegOrientation', () => {
  const app1 = (orientation: number, le: boolean) => {
    const t = Buffer.alloc(26);
    t.write(le ? 'II' : 'MM', 0, 'latin1');
    const w16 = (v: number, o: number) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o));
    const w32 = (v: number, o: number) => (le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o));
    w16(42, 2);
    w32(8, 4);
    w16(1, 8); // one entry
    w16(0x0112, 10);
    w16(3, 12);
    w32(1, 14);
    w16(orientation, 18);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
    const seg = Buffer.alloc(4);
    seg[0] = 0xff;
    seg[1] = 0xe1;
    seg.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([seg, body]);
  };
  const jpeg = new Uint8Array(readFileSync(join(IMAGES, 'opaque_photo.jpg')));
  const withExif = (orientation: number, le: boolean) => new Uint8Array(Buffer.concat([Buffer.from(jpeg.subarray(0, 2)), app1(orientation, le), Buffer.from(jpeg.subarray(2))]));

  it('reads orientation in both byte orders; defaults to 1', () => {
    expect(jpegOrientation(jpeg)).toBe(1);
    expect(jpegOrientation(withExif(6, true))).toBe(6);
    expect(jpegOrientation(withExif(8, false))).toBe(8);
    expect(jpegOrientation(withExif(1, false))).toBe(1);
    expect(jpegOrientation(withExif(42, true))).toBe(1);
  });
});

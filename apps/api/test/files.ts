/** Deterministic test files for upload validation (real fixtures + hand-built edge cases). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/images/', import.meta.url).href);
export const fixture = (name: string) => new Uint8Array(readFileSync(FIXTURES + name));

/** 1200×800 opaque PNG. */
export const trackingPng = () => fixture('tracking_target_20cm.png');
/** 512×512 PNG with alpha. */
export const alphaPng = () => fixture('ring_inner_hole.png');
/** 640×427 JPEG. */
export const photoJpeg = () => fixture('opaque_photo.jpg');
/** 101×701 PNG (too small for a tracking image's 256 px minimum). */
export const narrowPng = () => fixture('tall_npot.png');

const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** Minimal, valid GLB: JSON chunk (+ optional BIN chunk), 4-byte aligned. */
export function makeGlb(json: Record<string, unknown> = { asset: { version: '2.0', generator: 'test' }, buffers: [{ byteLength: 4 }], meshes: [{}], materials: [{}, {}] }, bin: Uint8Array | null = new Uint8Array([1, 2, 3, 4])): Uint8Array {
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  jsonBytes = Uint8Array.from([...jsonBytes, ...Array(jsonPad).fill(0x20)]);
  const binPad = bin ? (4 - (bin.length % 4)) % 4 : 0;
  const total = 12 + 8 + jsonBytes.length + (bin ? 8 + bin.length + binPad : 0);
  const out = new Uint8Array(total);
  out.set([0x67, 0x6c, 0x54, 0x46, ...le32(2), ...le32(total), ...le32(jsonBytes.length), ...le32(0x4e4f534a)], 0);
  out.set(jsonBytes, 20);
  if (bin) {
    const o = 20 + jsonBytes.length;
    out.set([...le32(bin.length + binPad), ...le32(0x004e4942)], o);
    out.set(bin, o + 8); // padding bytes stay 0
  }
  return out;
}

/** A PNG header claiming huge dimensions (decompression-bomb shape) followed by IEND. */
export function hugePng(width = 20000, height = 20000): Uint8Array {
  const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Split bytes into a stream of uneven chunks (exercises head buffering across chunk boundaries). */
export function chunked(bytes: Uint8Array, sizes = [1, 7, 13, 4096]): ReadableStream<Uint8Array> {
  let o = 0;
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (o >= bytes.length) return c.close();
      const n = sizes[i++ % sizes.length]!;
      c.enqueue(bytes.slice(o, o + n));
      o += n;
    },
  });
}

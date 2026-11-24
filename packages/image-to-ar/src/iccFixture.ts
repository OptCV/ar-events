/**
 * TEST FIXTURES ONLY (not exported from the package): minimal valid ICC v2 RGB matrix/TRC profiles and PNG/JPEG
 * containers that carry them (ADR-039). Mirrored by services/usd-processor/tests/icc_fixture.py.
 * Primaries are sRGB's (D50-adapted); `gamma` sets a pure power curve, so "Linear RGB" (gamma 1) differs from sRGB
 * only in its tone curve: a linear mid grey 128 becomes about 188 in sRGB.
 */
import { crc32, deflateSync } from 'node:zlib';

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const s15 = (x: number) => be32(Math.round(x * 65536) >>> 0);
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const pad4 = (a: number[]) => (a.length % 4 ? [...a, ...new Array(4 - (a.length % 4)).fill(0)] : a);

export function iccProfile(description: string, gamma: number): Uint8Array {
  const desc = pad4([...text('desc'), 0, 0, 0, 0, ...be32(description.length + 1), ...text(description), 0, ...be32(0), ...be32(0), 0, 0, 0, ...new Array(67).fill(0)]);
  const xyz = (x: number, y: number, z: number) => [...text('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)];
  const curv = pad4([...text('curv'), 0, 0, 0, 0, ...be32(1), (Math.round(gamma * 256) >> 8) & 255, Math.round(gamma * 256) & 255]);
  const tags: [string, number[]][] = [
    ['desc', desc],
    ['wtpt', xyz(0.9642, 1, 0.8249)],
    ['rXYZ', xyz(0.4361, 0.2225, 0.0139)],
    ['gXYZ', xyz(0.3851, 0.7169, 0.0971)],
    ['bXYZ', xyz(0.1431, 0.0606, 0.7141)],
    ['rTRC', curv],
    ['gTRC', curv],
    ['bTRC', curv],
  ];
  let offset = 128 + 4 + tags.length * 12;
  const table: number[] = [...be32(tags.length)];
  const data: number[] = [];
  for (const [sig, body] of tags) {
    table.push(...text(sig), ...be32(offset), ...be32(body.length));
    data.push(...body);
    offset += body.length;
  }
  const size = 128 + table.length + data.length;
  const header = [
    ...be32(size), 0, 0, 0, 0, 0x02, 0x10, 0, 0, ...text('mntr'), ...text('RGB '), ...text('XYZ '),
    ...new Array(12).fill(0), ...text('acsp'), ...new Array(4 + 4 + 4 + 4 + 8 + 4).fill(0),
    ...s15(0.9642), ...s15(1), ...s15(0.8249), ...new Array(4 + 16 + 28).fill(0),
  ];
  if (header.length !== 128) throw new Error(`ICC header is ${header.length} bytes`);
  return Uint8Array.from([...header, ...table, ...data]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const td = Uint8Array.from([...text(type), ...data]);
  return Uint8Array.from([...be32(data.length), ...td, ...be32(crc32(td) >>> 0)]);
}

/** A width×height RGB PNG filled with one colour, optionally tagged with an ICC profile or an sRGB chunk. */
export function taggedPng(width: number, height: number, rgb: [number, number, number], tag: Uint8Array | 'srgb' | null): Uint8Array {
  const ihdr = Uint8Array.from([...be32(width), ...be32(height), 8, 2, 0, 0, 0]);
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(...rgb);
  }
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (tag === 'srgb') parts.push(chunk('sRGB', Uint8Array.of(0)));
  else if (tag) parts.push(chunk('iCCP', Uint8Array.from([...text('test'), 0, 0, ...deflateSync(tag)])));
  parts.push(chunk('IDAT', deflateSync(Uint8Array.from(raw))), chunk('IEND', new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Inserts the profile as APP2 ICC_PROFILE segments (split into `pieces`) right after SOI of a JPEG. */
export function tagJpeg(jpeg: Uint8Array, profile: Uint8Array, pieces = 1): Uint8Array {
  const step = Math.ceil(profile.length / pieces);
  const segs: number[] = [];
  for (let i = 0; i < pieces; i++) {
    const part = profile.subarray(i * step, (i + 1) * step);
    const len = 2 + 12 + 2 + part.length;
    segs.push(0xff, 0xe2, (len >> 8) & 255, len & 255, ...text('ICC_PROFILE'), 0, i + 1, pieces, ...part);
  }
  return Uint8Array.from([...jpeg.subarray(0, 2), ...segs, ...jpeg.subarray(2)]);
}

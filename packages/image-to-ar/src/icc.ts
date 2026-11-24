/**
 * Embedded ICC colour profiles (Phase 7 M21, ADR-039). glTF and USDZ viewers treat textures as sRGB and ignore
 * embedded profiles, so an image tagged with another profile (Display P3 from iPhone photos, Adobe RGB, …) shows
 * wrong colours unless it is converted. This module only DETECTS: the converter (Pillow + LittleCMS) converts.
 *
 * "sRGB" = an RGB profile whose description names sRGB (e.g. "sRGB IEC61966-2.1", "sRGB built-in"), or a PNG with
 * an `sRGB` chunk. No profile at all is also treated as sRGB (the glTF/web default).
 */

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** PNG: the `iCCP` profile (zlib-inflated), 'srgb' for an `sRGB` chunk, or null. JPEG: the APP2 ICC_PROFILE chunks joined. */
export async function embeddedIccProfile(b: Uint8Array): Promise<Uint8Array | 'srgb' | null> {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    let o = 8;
    while (o + 12 <= b.length) {
      const len = u32(b, o);
      const type = ascii(b, o + 4, 4);
      if (type === 'IDAT' || type === 'IEND' || o + 12 + len > b.length) break;
      if (type === 'sRGB') return 'srgb';
      if (type === 'iCCP') {
        const data = b.subarray(o + 8, o + 8 + len);
        const nul = data.indexOf(0);
        if (nul < 1 || nul > 79 || data[nul + 1] !== 0) return null; // compression method must be 0 (zlib)
        try {
          return await inflate(data.subarray(nul + 2));
        } catch {
          return null; // unreadable profile: treated like none (viewers ignore it too)
        }
      }
      o += 12 + len;
    }
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    const parts: { seq: number; data: Uint8Array }[] = [];
    let o = 2;
    while (o + 4 <= b.length && b[o] === 0xff) {
      const marker = b[o + 1]!;
      if (marker === 0xda || marker === 0xd9) break;
      const len = (b[o + 2]! << 8) | b[o + 3]!;
      if (len < 2 || o + 2 + len > b.length) break;
      if (marker === 0xe2 && len > 16 && ascii(b, o + 4, 12) === 'ICC_PROFILE\0') parts.push({ seq: b[o + 16]!, data: b.subarray(o + 18, o + 2 + len) });
      o += 2 + len;
    }
    if (parts.length === 0) return null;
    parts.sort((x, y) => x.seq - y.seq);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.data.length, 0));
    let w = 0;
    for (const p of parts) {
      out.set(p.data, w);
      w += p.data.length;
    }
    return out;
  }
  return null;
}

/** The profile's description text ('desc' or 'mluc' tag), or null. */
export function iccDescription(p: Uint8Array): string | null {
  if (p.length < 132 || ascii(p, 36, 4) !== 'acsp') return null;
  const count = u32(p, 128);
  for (let i = 0; i < count && 132 + i * 12 + 12 <= p.length; i++) {
    const e = 132 + i * 12;
    if (ascii(p, e, 4) !== 'desc') continue;
    const off = u32(p, e + 4);
    const size = u32(p, e + 8);
    if (off + size > p.length || size < 12) return null;
    const type = ascii(p, off, 4);
    if (type === 'desc') {
      const n = u32(p, off + 8);
      return ascii(p, off + 12, Math.max(0, Math.min(n, size - 12))).replace(/\0+$/, '');
    }
    if (type === 'mluc') {
      const records = u32(p, off + 8);
      if (records < 1 || off + 28 > p.length) return null;
      const len = u32(p, off + 20);
      const start = off + u32(p, off + 24);
      if (start + len > p.length) return null;
      let s = '';
      for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode((p[start + k]! << 8) | p[start + k + 1]!);
      return s.replace(/\0+$/, '');
    }
    return null;
  }
  return null;
}

export function isSrgbProfile(p: Uint8Array): boolean {
  return p.length >= 20 && ascii(p, 16, 4) === 'RGB ' && /srgb/i.test(iccDescription(p) ?? '');
}

/** True when the image carries a colour profile other than sRGB, so it must be converted before embedding. */
export async function needsColorConversion(b: Uint8Array): Promise<boolean> {
  const p = await embeddedIccProfile(b);
  return p !== null && p !== 'srgb' && !isSrgbProfile(p);
}

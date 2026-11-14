import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
// @ts-expect-error gltf-validator ships no types
import validator from 'gltf-validator';
import { ImageToArSettings } from '@ar-creator/schema';
import { ImageFormatError, analyzeAlpha, buildImagePlaneGlb, buildQuad, readGlb, readImageInfo, resolveAlphaMode } from './index.ts';

const FIX = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures');
const manifest = JSON.parse(readFileSync(join(FIX, 'manifest.json'), 'utf8')) as {
  fixtures: { file: string; path: string; role: string; expectedAutoAlpha: string; sha256: string }[];
};
const load = (p: string) => new Uint8Array(readFileSync(join(FIX, p)));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function decodeRgba(bytes: Uint8Array) {
  const info = readImageInfo(bytes);
  if (info.mime === 'image/png') {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { rgba: new Uint8Array(png.data), w: png.width, h: png.height };
  }
  const j = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { rgba: j.data, w: j.width, h: j.height };
}

const display = manifest.fixtures.filter((f) => f.role === 'display-image');

describe('fixtures', () => {
  it('match the committed manifest hashes (generator is deterministic)', () => {
    for (const f of manifest.fixtures) expect(sha(load(f.path)), f.file).toBe(f.sha256);
  });
});

describe('readImageInfo', () => {
  it('reads PNG/JPEG headers without decoding', () => {
    expect(readImageInfo(load('images/alpha_steps.png'))).toEqual({ mime: 'image/png', width: 500, height: 100, mayHaveAlpha: true });
    expect(readImageInfo(load('images/orientation_probe.png')).mayHaveAlpha).toBe(false);
    expect(readImageInfo(load('images/opaque_photo.jpg'))).toEqual({ mime: 'image/jpeg', width: 640, height: 427, mayHaveAlpha: false });
  });
  it('rejects unknown signatures and oversized dimensions before decode', () => {
    expect(() => readImageInfo(new TextEncoder().encode('<svg></svg>'))).toThrow(ImageFormatError);
    const huge = new Uint8Array(load('images/alpha_steps.png'));
    new DataView(huge.buffer).setUint32(16, 100000); // forge IHDR width
    expect(() => readImageInfo(huge)).toThrow(/exceeds limits/);
  });
});

describe('alpha analysis / auto policy', () => {
  it.each(display.map((f) => [f.file, f.expectedAutoAlpha, f.path] as const))('%s → %s', (_f, expected, p) => {
    const { rgba, w, h } = decodeRgba(load(p));
    expect(resolveAlphaMode('auto', analyzeAlpha(rgba, w, h))).toBe(expected);
  });
  it('refuses OPAQUE when transparency exists', () => {
    const { rgba, w, h } = decodeRgba(load('images/ring_inner_hole.png'));
    expect(() => resolveAlphaMode('OPAQUE', analyzeAlpha(rgba, w, h))).toThrow(/refused/);
  });
  it('alpha_steps has exactly the five expected alpha levels', () => {
    const { rgba } = decodeRgba(load('images/alpha_steps.png'));
    const levels = new Set<number>();
    for (let i = 3; i < rgba.length; i += 4) levels.add(rgba[i]!);
    expect([...levels].sort((a, b) => a - b)).toEqual([0, 51, 128, 204, 255]);
  });
});

describe('buildQuad', () => {
  it('derives height from aspect ratio and honours pivot/orientation', () => {
    const q = buildQuad(600, 400, { widthMeters: 0.3, pivot: 'center', orientation: 'upright' });
    expect(q.heightMeters).toBeCloseTo(0.2, 6);
    expect(q.min).toEqual([Math.fround(-0.15), Math.fround(-0.1), 0]); // accessor min/max read from float32 data
    expect(q.max[1]).toBeCloseTo(0.1, 6);
    const b = buildQuad(600, 400, { widthMeters: 0.3, pivot: 'bottom-center', orientation: 'upright' });
    expect(b.min[1]).toBe(0);
    expect(b.max[1]).toBeCloseTo(0.2, 6);
    const f = buildQuad(600, 400, { widthMeters: 0.3, pivot: 'center', orientation: 'flat' });
    expect([f.min[1], f.max[1]]).toEqual([0, 0]);
    expect(Array.from(f.normals.slice(0, 3))).toEqual([0, 1, 0]);
  });
  it('maps image top-left (uv 0,0) to the top-left corner and winds CCW toward the normal', () => {
    for (const orientation of ['upright', 'flat'] as const) {
      const q = buildQuad(2, 1, { widthMeters: 2, pivot: 'center', orientation });
      const v = (i: number) => [q.positions[i * 3]!, q.positions[i * 3 + 1]!, q.positions[i * 3 + 2]!];
      const [a, b, c] = [v(q.indices[0]!), v(q.indices[1]!), v(q.indices[2]!)];
      const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const dot = n[0]! * q.normals[0]! + n[1]! * q.normals[1]! + n[2]! * q.normals[2]!;
      expect(dot, orientation).toBeGreaterThan(0);
      // vertex 0 = TL has uv (0,0) and is at -X and image-up
      expect([q.uvs[0], q.uvs[1]]).toEqual([0, 0]);
      expect(v(0)[0]).toBeLessThan(0);
      if (orientation === 'upright') expect(v(0)[1]).toBeGreaterThan(0);
      else expect(v(0)[2]).toBeLessThan(0);
    }
  });
});

describe('buildImagePlaneGlb', () => {
  it.each(display.map((f) => [f.file, f.path] as const))('%s → valid GLB with original image embedded bytewise', async (_f, p) => {
    const bytes = load(p);
    const { rgba, w, h } = decodeRgba(bytes);
    const settings = ImageToArSettings.parse({ widthMeters: 0.5, shapeMode: 'flat', alphaMode: 'auto' });
    const alphaMode = resolveAlphaMode('auto', analyzeAlpha(rgba, w, h));
    const res = buildImagePlaneGlb({ image: bytes, settings, alphaMode });

    const report = await validator.validateBytes(res.glb, { maxIssues: 50 });
    expect(report.issues.numErrors, JSON.stringify(report.issues.messages)).toBe(0);
    expect(report.issues.numWarnings, JSON.stringify(report.issues.messages)).toBe(0);

    const { json, bin } = readGlb(res.glb);
    const view = json.bufferViews[json.images[0].bufferView];
    const embedded = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    expect(sha(embedded)).toBe(sha(bytes)); // alpha preserved: no re-encode, no flattening
    expect(json.materials[0].alphaMode).toBe(alphaMode);
    expect(json.materials[0].doubleSided).toBe(false);
    expect(json.extras.arCreator.widthMeters).toBe(0.5);
    expect(json.extras.arCreator.heightMeters).toBeCloseTo((0.5 * h) / w, 4);
    if (alphaMode === 'MASK') expect(json.materials[0].alphaCutoff).toBe(0.5);
    else expect(json.materials[0].alphaCutoff).toBeUndefined();
  });

  it('is deterministic for identical input + settings', () => {
    const bytes = load('images/aa_disc_dark_fringe.png');
    const s = ImageToArSettings.parse({ widthMeters: 0.3, shapeMode: 'flat', alphaMode: 'BLEND', doubleSided: true });
    const a = buildImagePlaneGlb({ image: bytes, settings: s, alphaMode: 'BLEND' });
    const b = buildImagePlaneGlb({ image: bytes, settings: s, alphaMode: 'BLEND' });
    expect(sha(a.glb)).toBe(sha(b.glb));
    expect(readGlb(a.glb).json.materials[0].doubleSided).toBe(true);
  });

  it('refuses alpha modes on JPEG', () => {
    const s = ImageToArSettings.parse({ widthMeters: 0.3, shapeMode: 'flat', alphaMode: 'BLEND' });
    expect(() => buildImagePlaneGlb({ image: load('images/opaque_photo.jpg'), settings: s, alphaMode: 'BLEND' })).toThrow(/JPEG/);
  });
});

describe('geometry golden (shared with services/usd-processor)', () => {
  const golden = JSON.parse(readFileSync(join(FIX, 'geometry_golden.json'), 'utf8')) as { cases: any[] };
  it.each(golden.cases.map((c) => [`${c.pixelWidth}x${c.pixelHeight} ${c.pivot} ${c.orientation}`, c]))('%s', (_n, c) => {
    const q = buildQuad(c.pixelWidth, c.pixelHeight, { widthMeters: c.widthMeters, pivot: c.pivot, orientation: c.orientation });
    expect(q.heightMeters).toBe(c.heightMeters);
    expect(Array.from(q.positions)).toEqual(c.positions);
    expect(Array.from(q.uvs)).toEqual(c.uvs);
    expect(Array.from(q.indices)).toEqual(c.indices);
  });
});

/**
 * Deterministic golden fixtures for Image-to-AR and P0 runtime proofs (IMAGE_TO_AR.md "Golden fixtures").
 * Run: npm run fixtures   → writes tests/fixtures/images/*.{png,jpg} and tests/fixtures/manifest.json
 * Output bytes must be identical across runs (checked by fixtures.test.ts).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

type RGBA = [number, number, number, number];
type Shader = (x: number, y: number, w: number, h: number) => RGBA;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
const imgDir = join(root, 'images');

function render(w: number, h: number, shade: Shader): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) data.set(shade(x, y, w, h).map((v) => Math.max(0, Math.min(255, Math.round(v)))), (y * w + x) * 4);
  return data;
}

function encodePng(w: number, h: number, data: Uint8Array, colorType: 2 | 6 = 6): Buffer {
  const png = new PNG({ width: w, height: h, colorType, inputColorType: 6, bitDepth: 8 });
  png.data = Buffer.from(data);
  return PNG.sync.write(png, { colorType, inputColorType: 6, deflateLevel: 9, filterType: 4 });
}

/** Coverage of a disc for 4x4 supersampling → genuine antialiased edges. */
function discCoverage(x: number, y: number, cx: number, cy: number, r: number): number {
  let hit = 0;
  for (let sy = 0; sy < 4; sy++)
    for (let sx = 0; sx < 4; sx++) {
      const dx = x + (sx + 0.5) / 4 - cx;
      const dy = y + (sy + 0.5) / 4 - cy;
      if (dx * dx + dy * dy <= r * r) hit++;
    }
  return hit / 16;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fixture {
  file: string;
  role: 'display-image' | 'tracking-image';
  description: string;
  expectedAutoAlpha: 'OPAQUE' | 'MASK' | 'BLEND';
  bytes: Buffer;
}
const fixtures: Fixture[] = [];
const add = (f: Fixture) => fixtures.push(f);

// 1. Opaque JPEG photo-like gradient.
{
  const w = 640, h = 427;
  const data = render(w, h, (x, y) => [40 + (180 * x) / w, 90 + (120 * y) / h, 200 - (150 * x) / w, 255]);
  const bytes = Buffer.from(jpeg.encode({ data: Buffer.from(data), width: w, height: h }, 90).data);
  add({ file: 'opaque_photo.jpg', role: 'display-image', description: 'Opaque JPEG; must produce OPAQUE material.', expectedAutoAlpha: 'OPAQUE', bytes });
}

// 2. Transparent border around a hard-edged opaque logo (binary alpha).
{
  const w = 512, h = 256;
  const data = render(w, h, (x, y) => {
    const inside = x >= 64 && x < 448 && y >= 48 && y < 208;
    const stripe = inside && ((x >> 5) & 1) === 0;
    return inside ? (stripe ? [33, 92, 197, 255] : [245, 180, 20, 255]) : [0, 0, 0, 0];
  });
  add({ file: 'logo_transparent_border.png', role: 'display-image', description: 'Opaque logo with fully transparent border; binary alpha.', expectedAutoAlpha: 'MASK', bytes: encodePng(w, h, data) });
}

// 3. Internal fully transparent hole (ring), binary alpha.
{
  const s = 512;
  const data = render(s, s, (x, y) => {
    const d = Math.hypot(x + 0.5 - s / 2, y + 0.5 - s / 2);
    return d <= 230 && d >= 120 ? [184, 47, 57, 255] : [0, 0, 0, 0];
  });
  add({ file: 'ring_inner_hole.png', role: 'display-image', description: 'Ring with transparent outside AND transparent inner hole; quad stays rectangular.', expectedAutoAlpha: 'MASK', bytes: encodePng(s, s, data) });
}

// 4. Alpha steps 0, 0.2, 0.5, 0.8, 1.
{
  const w = 500, h = 100;
  const steps = [0, 51, 128, 204, 255];
  const data = render(w, h, (x) => [20, 140, 80, steps[Math.floor(x / 100)]!]);
  add({ file: 'alpha_steps.png', role: 'display-image', description: 'Five bands alpha 0/0.2/0.5/0.8/1.0 (green); semitransparency fidelity.', expectedAutoAlpha: 'BLEND', bytes: encodePng(w, h, data) });
}

// 5. Antialiased disc with near-transparent dark fringe (halo trap).
{
  const s = 400;
  const data = render(s, s, (x, y) => {
    const core = discCoverage(x, y, 200, 200, 150);
    if (core > 0) return [255, 255, 255, 255 * core];
    const fringe = discCoverage(x, y, 200, 200, 158);
    return fringe > 0 ? [0, 0, 0, 6 * fringe] : [0, 0, 0, 0];
  });
  add({ file: 'aa_disc_dark_fringe.png', role: 'display-image', description: 'White AA disc with almost-invisible black fringe; dark halo = premultiply/filter bug.', expectedAutoAlpha: 'BLEND', bytes: encodePng(s, s, data) });
}

// 6/7. Very tall and very wide, non-power-of-two.
{
  const w = 101, h = 701;
  const data = render(w, h, (x, y) => [255 * (y / h), 60, 255 - 255 * (y / h), x < 10 || x > 90 ? 0 : 255]);
  add({ file: 'tall_npot.png', role: 'display-image', description: '101x701 NPOT tall strip with transparent side margins.', expectedAutoAlpha: 'MASK', bytes: encodePng(w, h, data) });
}
{
  const w = 903, h = 117;
  const data = render(w, h, (x, y) => [90, 255 * (x / w), 160, y < 8 || y > 108 ? 0 : 255]);
  add({ file: 'wide_npot.png', role: 'display-image', description: '903x117 NPOT wide banner with transparent top/bottom margins.', expectedAutoAlpha: 'MASK', bytes: encodePng(w, h, data) });
}

// 8. Orientation probe: corner colours + up-arrow; reveals UV flips/mirroring on device.
{
  const w = 600, h = 400;
  const data = render(w, h, (x, y) => {
    const corner = 120;
    if (x < corner && y < corner) return [220, 30, 30, 255]; // TL red
    if (x >= w - corner && y < corner) return [30, 170, 60, 255]; // TR green
    if (x < corner && y >= h - corner) return [30, 80, 220, 255]; // BL blue
    if (x >= w - corner && y >= h - corner) return [240, 200, 20, 255]; // BR yellow
    // up arrow centred: triangle head + shaft
    const cx = w / 2;
    const head = y >= 60 && y < 180 && Math.abs(x - cx) <= (y - 60) * 0.75;
    const shaft = y >= 180 && y < 340 && Math.abs(x - cx) <= 30;
    if (head || shaft) return [20, 20, 20, 255];
    return [250, 250, 250, 255];
  });
  add({ file: 'orientation_probe.png', role: 'display-image', description: 'Opaque. TL red, TR green, BL blue, BR yellow, black arrow points to image top.', expectedAutoAlpha: 'OPAQUE', bytes: encodePng(w, h, data, 2) });
}

// 9. Tracking target: high-contrast, feature-dense, non-repeating, asymmetric (3:2, printed at 20 cm wide).
{
  const w = 1200, h = 800;
  const rnd = mulberry32(20261114);
  const rects = Array.from({ length: 420 }, () => {
    const rw = 10 + rnd() * 110, rh = 10 + rnd() * 110;
    return { x: rnd() * (w - rw), y: rnd() * (h - rh), rw, rh, c: [rnd() * 255, rnd() * 255, rnd() * 255] as const };
  });
  const data = render(w, h, (x, y) => {
    if (x < 24 || y < 24 || x >= w - 24 || y >= h - 24) return [0, 0, 0, 255]; // border
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i]!;
      if (x >= r.x && x < r.x + r.rw && y >= r.y && y < r.y + r.rh) return [r.c[0], r.c[1], r.c[2], 255];
    }
    return [255, 255, 255, 255];
  });
  add({ file: 'tracking_target_20cm.png', role: 'tracking-image', description: 'Tracking reference, print at 20.0 cm width (3:2). Opaque, feature-dense, asymmetric.', expectedAutoAlpha: 'OPAQUE', bytes: encodePng(w, h, data, 2) });
}

mkdirSync(imgDir, { recursive: true });
const manifest = fixtures.map(({ bytes, ...f }) => {
  writeFileSync(join(imgDir, f.file), bytes);
  return { ...f, path: `images/${f.file}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
writeFileSync(join(root, 'manifest.json'), JSON.stringify({ generator: 'scripts/generate-fixtures.ts', fixtures: manifest }, null, 2) + '\n');
console.log(manifest.map((m) => `${m.sha256.slice(0, 12)}  ${m.path}`).join('\n'));

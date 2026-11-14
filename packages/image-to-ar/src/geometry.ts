import type { ImageToArSettings } from '@ar-creator/schema';

export interface QuadGeometry {
  widthMeters: number;
  heightMeters: number;
  /** 4 vertices: TL, BL, BR, TR. */
  positions: Float32Array;
  normals: Float32Array;
  /** glTF UV convention: origin top-left, v down. (USD `st` is v-up: st = (u, 1 - v).) */
  uvs: Float32Array;
  indices: Uint16Array;
  min: [number, number, number];
  max: [number, number, number];
}

/** Height from intrinsic aspect ratio, rounded to 0.1 mm to keep outputs deterministic across runtimes. */
export function physicalSize(pixelWidth: number, pixelHeight: number, widthMeters: number) {
  const heightMeters = Math.round((widthMeters * pixelHeight * 10000) / pixelWidth) / 10000;
  return { widthMeters, heightMeters };
}

/**
 * Flat image quad in the canonical frame (ADR-005):
 *  - upright: XY plane, facing +Z; image top is +Y.
 *  - flat:    XZ plane, facing +Y; image top is -Z, image bottom is +Z (matches the image-anchor frame).
 * Winding is counter-clockwise when viewed from the facing side.
 */
export function buildQuad(
  pixelWidth: number,
  pixelHeight: number,
  s: Pick<ImageToArSettings, 'widthMeters' | 'pivot' | 'orientation'>,
): QuadGeometry {
  const { widthMeters: w, heightMeters: h } = physicalSize(pixelWidth, pixelHeight, s.widthMeters);
  const x0 = -w / 2;
  const x1 = w / 2;
  // "up" coordinate of the bottom and top edges along the image's vertical axis
  const bottom = s.pivot === 'bottom-center' ? 0 : -h / 2;
  const top = bottom + h;
  let corners: number[][]; // TL, BL, BR, TR
  let normal: number[];
  if (s.orientation === 'upright') {
    corners = [[x0, top, 0], [x0, bottom, 0], [x1, bottom, 0], [x1, top, 0]];
    normal = [0, 0, 1];
  } else {
    // image "up" maps to -Z
    corners = [[x0, 0, -top], [x0, 0, -bottom], [x1, 0, -bottom], [x1, 0, -top]];
    normal = [0, 1, 0];
  }
  // `+ 0` canonicalizes -0 → 0 so outputs are byte-stable and match the JSON golden contract.
  const positions = new Float32Array(corners.flat().map((v) => v + 0));
  const normals = new Float32Array([...normal, ...normal, ...normal, ...normal]);
  const uvs = new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]);
  const indices = new Uint16Array([1, 2, 3, 1, 3, 0]);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 12; i++) {
    const v = positions[i]!;
    const a = i % 3;
    if (v < min[a]!) min[a] = v;
    if (v > max[a]!) max[a] = v;
  }
  return { widthMeters: w, heightMeters: h, positions, normals, uvs, indices, min, max };
}

import type { SceneNode, Transform } from '@ar-creator/schema';

/**
 * Transform math for the editor (Phase 3 M10), independent of three.js so it stays out of the main bundle.
 * Stored: meters, unit quaternion [x, y, z, w], scale [x, y, z] (DATA_MODEL.md). Shown: centimetres, degrees
 * (intrinsic X → Y → Z Euler order, as three.js 'XYZ'), percent.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Limits for typed values; outside them a value is almost certainly a unit mistake. */
export const LIMITS = { positionM: 100, scaleMin: 0.01, scaleMax: 100 } as const;
/** Snapping steps used by the gizmos when snapping is on. */
export const SNAP = { positionM: 0.01, rotationDeg: 15, scale: 0.05 } as const;

export function normalizeQuat(q: readonly number[]): Quat {
  const len = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
  if (!Number.isFinite(len) || len < 1e-12) return [0, 0, 0, 1];
  // Canonical sign (w ≥ 0): the same rotation always stores the same numbers.
  const s = (q[3]! < 0 ? -1 : 1) / len;
  return [q[0]! * s, q[1]! * s, q[2]! * s, q[3]! * s].map((v) => (Object.is(v, -0) ? 0 : v)) as Quat;
}

/** Degrees (intrinsic X, Y, Z) → unit quaternion. Same formula as three.js Quaternion.setFromEuler('XYZ'). */
export function quatFromEulerDeg([xd, yd, zd]: readonly number[]): Quat {
  const [x, y, z] = [xd! * DEG, yd! * DEG, zd! * DEG];
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return normalizeQuat([s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3]);
}

/** Unit quaternion → degrees (intrinsic X, Y, Z), each in (−180, 180]. Same as three.js Euler.setFromQuaternion('XYZ'). */
export function eulerDegFromQuat(q: readonly number[]): Vec3 {
  const [x, y, z, w] = normalizeQuat(q);
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
  const ry = Math.asin(clamp(m13, -1, 1));
  let rx: number, rz: number;
  if (Math.abs(m13) < 0.9999999) {
    rx = Math.atan2(-m23, m33);
    rz = Math.atan2(-m12, m11);
  } else {
    rx = Math.atan2(m32, m22); // gimbal lock: put the whole twist on X
    rz = 0;
  }
  return [rx, ry, rz].map((r) => tidy(r / DEG)) as Vec3;
}

/** Rounds to 0.0001° (asin near ±90° is imprecise) and folds −180 to 180 and −0 to 0 so displayed values are stable. */
function tidy(deg: number): number {
  let v = Math.round(deg * 1e4) / 1e4;
  if (v <= -180) v += 360;
  return Object.is(v, -0) ? 0 : v;
}

export const snap = (v: number, step: number) => Math.round(v / step) * step;

/** True when all scale components are equal (within 1e-9). */
export const isUniform = (s: readonly number[]) => Math.abs(s[0]! - s[1]!) < 1e-9 && Math.abs(s[1]! - s[2]!) < 1e-9;

/**
 * Uniform scale after a gizmo drag: the component that moved furthest from `before` wins, so dragging any handle
 * scales proportionally (flat pictures must never be stretched).
 */
export function uniformFromDrag(before: readonly number[], after: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(after[i]! - before[i]!) > Math.abs(after[best]! - before[best]!)) best = i;
  return clamp(after[best]!, LIMITS.scaleMin, LIMITS.scaleMax);
}

/** Rounds stored numbers (µm, 1e-9 quaternion) so equal-looking transforms compare equal and JSON stays small. */
export function cleanTransform(t: Transform): Transform {
  const r = (v: number, k: number) => {
    const x = Math.round(v * k) / k;
    return Object.is(x, -0) ? 0 : x;
  };
  return {
    position: t.position.map((v) => r(v, 1e6)) as Vec3,
    rotation: normalizeQuat(normalizeQuat(t.rotation).map((v) => r(v, 1e9))),
    scale: t.scale.map((v) => r(v, 1e6)) as Vec3,
  };
}

export function sameTransform(a: Transform, b: Transform): boolean {
  const ca = cleanTransform(a);
  const cb = cleanTransform(b);
  return [...ca.position, ...ca.rotation, ...ca.scale].every((v, i) => v === [...cb.position, ...cb.rotation, ...cb.scale][i]);
}

/** A copy of a node (new id, " copy" name), offset 10 cm along +X so it does not hide the original. */
export function duplicateNode<N extends SceneNode>(n: N, id: string): N {
  const t = n.transform;
  return {
    ...n,
    id,
    name: `${(n.name?.trim() || 'Object').slice(0, 115)} copy`,
    locked: false,
    transform: cleanTransform({ ...t, position: [t.position[0] + 0.1, t.position[1], t.position[2]] }),
  };
}

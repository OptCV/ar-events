/**
 * Anchor composition: world ← imagePose · frameCorrection · authoredLocal.
 * ADR-005 hypothesis H3: the Chrome image pose already equals the canonical image frame
 * (+Y normal, +X image right, +Z image bottom), so the default correction is identity.
 * If AND-IMG-01 disproves H3, set the correction here only (and record an ADR).
 * Matrices are column-major Float32Array(16), as in XRRigidTransform.matrix.
 */
export type Mat4 = Float32Array;

export const IDENTITY: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  return out;
}

export const IMAGE_FRAME_CORRECTION: Mat4 = IDENTITY;

export function composeAnchor(imagePose: Mat4, correction: Mat4 = IMAGE_FRAME_CORRECTION): Mat4 {
  return multiply(imagePose, correction);
}

/** Apply a column-major matrix to a point (used by tests and diagnostics). */
export function transformPoint(m: Mat4, p: [number, number, number]): [number, number, number] {
  const [x, y, z] = p;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

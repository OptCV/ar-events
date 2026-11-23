import { describe, expect, it } from 'vitest';
import { IDENTITY_TRANSFORM, Quat as QuatSchema, Transform, type SceneNode } from '@ar-creator/schema';
import { cleanTransform, duplicateNode, eulerDegFromQuat, isUniform, normalizeQuat, quatFromEulerDeg, sameTransform, snap, uniformFromDrag } from './transforms.ts';
import { HISTORY_LIMIT, emptyHistory, record, redo, undo } from './history.ts';

const S = Math.SQRT1_2;
const close = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(eps));

describe('transform math (M10)', () => {
  it('degrees → quaternion matches known rotations and is normalized for the schema', () => {
    close(quatFromEulerDeg([0, 90, 0]), [0, S, 0, S]);
    close(quatFromEulerDeg([-90, 0, 0]), [-S, 0, 0, S]);
    close(quatFromEulerDeg([0, 0, 180]), [0, 0, 1, 0]);
    close(quatFromEulerDeg([0, 0, 0]), [0, 0, 0, 1]);
    for (const e of [[10, 20, 30], [-170, 45, 90], [359, -359, 720]]) expect(QuatSchema.safeParse(quatFromEulerDeg(e)).success).toBe(true);
  });

  it('quaternion → degrees round-trips away from gimbal lock and stays stable at it', () => {
    for (const e of [[10, 20, 30], [-170, 45, 90], [0, -89, 0], [180, 0, 0], [0, 0, -90]] as const) {
      close(quatFromEulerDeg(eulerDegFromQuat(quatFromEulerDeg(e))), quatFromEulerDeg(e), 1e-5);
    }
    expect(eulerDegFromQuat([0, S, 0, S])).toEqual([0, 90, 0]);
    expect(eulerDegFromQuat(quatFromEulerDeg([-180, 0, 0]))).toEqual([180, 0, 0]); // −180 is shown as 180
    // Gimbal lock (Y = 90): still the same rotation.
    close(quatFromEulerDeg(eulerDegFromQuat(quatFromEulerDeg([30, 90, 40]))), quatFromEulerDeg([30, 90, 40]), 1e-5);
  });

  it('normalizes quaternions to a canonical sign and guards degenerate input', () => {
    close(normalizeQuat([0, 0, 0, -2]), [0, 0, 0, 1]);
    close(normalizeQuat([0, -S, 0, -S]), [0, S, 0, S]);
    expect(normalizeQuat([0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
    expect(normalizeQuat([NaN, 0, 0, 1])).toEqual([0, 0, 0, 1]);
  });

  it('snaps, keeps scale uniform after a drag, and cleans float noise', () => {
    expect(snap(0.1234, 0.01)).toBeCloseTo(0.12, 12);
    expect(snap(37, 15)).toBe(30);
    expect(uniformFromDrag([1, 1, 1], [1, 1.4, 1.02])).toBe(1.4);
    expect(uniformFromDrag([1, 1, 1], [0.0001, 1, 1])).toBe(0.01);
    expect(isUniform([2, 2, 2])).toBe(true);
    expect(isUniform([2, 1, 2])).toBe(false);
    const t = cleanTransform({ position: [0.1 + 0.2, -0, 1e-12], rotation: [0, 0, 0, 1.0000000001], scale: [1, 1, 1] });
    expect(t).toEqual({ position: [0.3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(Transform.safeParse(t).success).toBe(true);
    expect(sameTransform(t, { position: [0.3000000001, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] })).toBe(true);
  });

  it('duplicates a node with a new id, a "copy" name, unlocked and offset 10 cm', () => {
    const n = { id: 'a', kind: 'image-object', derivativeId: 'd', name: 'Ring', transform: { ...IDENTITY_TRANSFORM, position: [0.05, 0, 0] }, visible: true, locked: true } as SceneNode;
    expect(duplicateNode(n, 'b')).toMatchObject({ id: 'b', name: 'Ring copy', locked: false, derivativeId: 'd', transform: { position: [0.15, 0, 0] } });
  });
});

describe('undo/redo history (M10)', () => {
  const n = (id: string) => ({ nodes: [{ id, kind: 'group', transform: IDENTITY_TRANSFORM, visible: true, locked: false }] as SceneNode[], actions: [] });

  it('undoes and redoes in order; a new edit clears redo; no-op edits are not recorded', () => {
    let h = emptyHistory();
    h = record(h, n('a'), n('b'));
    h = record(h, n('b'), n('c'));
    expect(record(h, n('c'), n('c'))).toBe(h);
    const u1 = undo(h, n('c'))!;
    expect(u1.content.nodes[0]!.id).toBe('b');
    const u2 = undo(u1.history, u1.content)!;
    expect(u2.content.nodes[0]!.id).toBe('a');
    expect(undo(u2.history, u2.content)).toBeNull();
    const r1 = redo(u2.history, u2.content)!;
    expect(r1.content.nodes[0]!.id).toBe('b');
    const branched = record(r1.history, r1.content, n('x'));
    expect(redo(branched, n('x'))).toBeNull();
  });

  it(`keeps at most ${HISTORY_LIMIT} steps`, () => {
    let h = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = record(h, n(`s${i}`), n(`s${i + 1}`));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]!.nodes[0]!.id).toBe('s20');
  });
});

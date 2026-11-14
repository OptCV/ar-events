import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  ImageAnchorTracker,
  TrackingStateMachine,
  WidthStats,
  buildSessionInit,
  composeAnchor,
  describeStartError,
  preflight,
  resolveImageTrackingApi,
  resultForIndex,
  transformPoint,
  type XRImageTrackingResult,
} from './index.ts';

const bitmap = {} as ImageBitmap;

describe('buildSessionInit', () => {
  it('requests image tracking and dom-overlay as optional features', () => {
    const root = {} as Element;
    const init = buildSessionInit([{ image: bitmap, widthInMeters: 0.2 }], root);
    expect(init.requiredFeatures).toEqual(['local']);
    expect(init.optionalFeatures).toEqual(['image-tracking', 'dom-overlay']);
    expect(init.trackedImages).toHaveLength(1);
    expect(init.domOverlay?.root).toBe(root);
  });
  it('omits dom-overlay without a root and rejects bad widths', () => {
    expect(buildSessionInit([{ image: bitmap, widthInMeters: 0.2 }]).optionalFeatures).toEqual(['image-tracking']);
    expect(() => buildSessionInit([{ image: bitmap, widthInMeters: 20 }])).toThrow(/implausible/);
    expect(() => buildSessionInit([])).toThrow();
  });
});

describe('resolveImageTrackingApi', () => {
  const scores = async () => ['trackable'] as const;
  it('accepts the Chrome image-tracking shape when granted', async () => {
    const r = resolveImageTrackingApi({ enabledFeatures: ['local', 'image-tracking'], getTrackedImageScores: scores });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(await r.api.getScores()).toEqual(['trackable']);
      expect(r.api.getResults({})).toEqual([]); // frame without the method → no results, no throw
    }
  });
  it('reports feature-not-granted when the UA declined (flag off)', () => {
    const r = resolveImageTrackingApi({ enabledFeatures: ['local', 'viewer'], getTrackedImageScores: scores });
    expect(r).toMatchObject({ ok: false, reason: 'feature-not-granted' });
    expect(resolveImageTrackingApi({ enabledFeatures: ['local'] })).toMatchObject({ ok: false, reason: 'feature-not-granted' });
  });
  it('falls back to method detection when enabledFeatures is absent', () => {
    expect(resolveImageTrackingApi({ getTrackedImageScores: scores }).ok).toBe(true);
    expect(resolveImageTrackingApi({}).ok).toBe(false);
  });
  it('never guesses at marker-tracking or a granted feature without the expected methods', () => {
    expect(resolveImageTrackingApi({ enabledFeatures: ['marker-tracking'] })).toMatchObject({ ok: false, reason: 'unrecognized-api' });
    expect(resolveImageTrackingApi({ enabledFeatures: ['image-tracking'] })).toMatchObject({ ok: false, reason: 'unrecognized-api' });
  });
  it('resultForIndex picks the matching target', () => {
    const r = (index: number) => ({ index, trackingState: 'tracked', measuredWidthInMeters: 0.2, imageSpace: {} }) as XRImageTrackingResult;
    expect(resultForIndex([r(1), r(0)], 0)?.index).toBe(0);
    expect(resultForIndex([r(1)], 0)).toBeNull();
  });
});

describe('TrackingStateMachine', () => {
  it('scanning → tracked → emulated → lost → tracked with hysteresis', () => {
    const sm = new TrackingStateMachine(3);
    expect(sm.update(null)).toBeNull();
    expect(sm.status).toBe('scanning');
    expect(sm.contentVisible).toBe(false);
    expect(sm.update('tracked')).toMatchObject({ from: 'scanning', to: 'tracked', frame: 2 });
    expect(sm.contentVisible).toBe(true);
    expect(sm.update('emulated')).toMatchObject({ to: 'emulated' });
    expect(sm.update(null)).toBeNull();
    expect(sm.update(null)).toBeNull();
    expect(sm.status).toBe('emulated'); // short gap does not flicker
    expect(sm.update(null)).toMatchObject({ from: 'emulated', to: 'lost' });
    expect(sm.contentVisible).toBe(false);
    expect(sm.update('tracked')).toMatchObject({ from: 'lost', to: 'tracked' });
  });
  it('never goes from scanning straight to lost', () => {
    const sm = new TrackingStateMachine(2);
    for (let i = 0; i < 10; i++) sm.update(null);
    expect(sm.status).toBe('scanning');
  });
});

describe('WidthStats', () => {
  it('reports median and ratio to the registered width', () => {
    const w = new WidthStats();
    for (const v of [0.19, 0.2, 0.21, Number.NaN, -1]) w.add(v);
    expect(w.summary(0.2)).toEqual({ samples: 3, min: 0.19, max: 0.21, median: 0.2, ratioToRegistered: 1 });
    expect(new WidthStats().summary(0.2)).toBeNull();
  });
});

describe('composeAnchor', () => {
  it('identity correction keeps the image pose (ADR-005 H3)', () => {
    // pose: translate (1,2,3), rotate 90° about Y (x→-z)
    const pose = new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 2, 3, 1]);
    const m = composeAnchor(pose);
    expect(Array.from(m)).toEqual(Array.from(pose));
    expect(transformPoint(m, [1, 0, 0])).toEqual([1, 2, 2]);
    expect(Array.from(composeAnchor(IDENTITY, pose))).toEqual(Array.from(pose));
  });
});

describe('preflight', () => {
  it('requires HTTPS and immersive-ar', async () => {
    expect((await preflight({ isSecureContext: false })).canAttempt).toBe(false);
    expect((await preflight({ isSecureContext: true })).webxr).toBe(false);
    const no = await preflight({ isSecureContext: true, xr: { isSessionSupported: async () => false } });
    expect(no).toMatchObject({ immersiveAr: false, canAttempt: false });
    const err = await preflight({ isSecureContext: true, xr: { isSessionSupported: async () => { throw new Error('x'); } } });
    expect(err.immersiveAr).toBe('error');
    const hang = await preflight({ isSecureContext: true, timeoutMs: 20, xr: { isSessionSupported: () => new Promise<boolean>(() => {}) } });
    expect(hang).toMatchObject({ immersiveAr: 'error', canAttempt: false });
    const ok = await preflight({ isSecureContext: true, xr: { isSessionSupported: async () => true } });
    expect(ok).toMatchObject({ canAttempt: true, messages: [] });
  });
  it('maps DOMException names to user messages', () => {
    expect(describeStartError({ name: 'NotAllowedError' })).toMatch(/permission/);
    expect(describeStartError(new Error('boom'))).toMatch(/failed to start \(Error\)/);
  });
});

describe('ImageAnchorTracker', () => {
  const space = {} as XRSpace;
  const ref = {} as XRSpace;
  const poseAt = (z: number) => ({ transform: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1]) } });
  const make = () => {
    let next: XRImageTrackingResult[] = [];
    let pose: ReturnType<typeof poseAt> | null = poseAt(-0.5);
    const api = { kind: 'chrome-image-tracking' as const, getScores: async () => [], getResults: () => next };
    const frame = { getPose: () => pose };
    return {
      tracker: new ImageAnchorTracker(api, { lostAfterFrames: 2 }),
      frame,
      see: (state: 'tracked' | 'emulated', width = 0.2) =>
        (next = [{ index: 0, imageSpace: space, trackingState: state, measuredWidthInMeters: width } as XRImageTrackingResult]),
      hide: () => (next = []),
      setPose: (p: ReturnType<typeof poseAt> | null) => (pose = p),
    };
  };

  it('hidden while scanning, shown with the composed pose once tracked', () => {
    const t = make();
    expect(t.tracker.onFrame(t.frame, ref)).toMatchObject({ status: 'scanning', visible: false, anchorMatrix: null });
    t.see('tracked', 0.201);
    const u = t.tracker.onFrame(t.frame, ref);
    expect(u).toMatchObject({ status: 'tracked', visible: true, measuredWidthMeters: 0.201 });
    expect(u.transition).toMatchObject({ from: 'scanning', to: 'tracked' });
    expect(Array.from(u.anchorMatrix!).slice(12, 15)).toEqual([0, 0, -0.5]);
  });

  it('keeps the last pose through a short gap, hides after lost, needs a new pose to reappear', () => {
    const t = make();
    t.see('tracked');
    t.tracker.onFrame(t.frame, ref);
    t.hide();
    expect(t.tracker.onFrame(t.frame, ref)).toMatchObject({ visible: true, anchorMatrix: null });
    expect(t.tracker.onFrame(t.frame, ref)).toMatchObject({ status: 'lost', visible: false });
    t.see('emulated');
    t.setPose(null); // result without a pose this frame
    expect(t.tracker.onFrame(t.frame, ref)).toMatchObject({ status: 'emulated', visible: false });
    t.setPose(poseAt(-1));
    expect(t.tracker.onFrame(t.frame, ref)).toMatchObject({ status: 'emulated', visible: true });
  });

  it('never shows content without a reference space', () => {
    const t = make();
    t.see('tracked');
    expect(t.tracker.onFrame(t.frame, null)).toMatchObject({ status: 'tracked', visible: false, anchorMatrix: null });
    expect(t.tracker.widths.summary(0.2)?.samples).toBe(1);
  });
});

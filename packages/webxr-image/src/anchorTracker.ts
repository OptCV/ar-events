import { resultForIndex, type ImageTrackingApi } from './adapter.ts';
import { IMAGE_FRAME_CORRECTION, composeAnchor, type Mat4 } from './pose.ts';
import { TrackingStateMachine, WidthStats, type TrackingStatus, type TrackingTransition } from './tracking.ts';

/** The parts of XRFrame the tracker uses (structural so it can be unit-tested without a device). */
export interface PoseFrame {
  getPose(space: XRSpace, baseSpace: XRSpace): { transform: { matrix: Float32Array } } | null | undefined;
}

export interface FrameUpdate {
  status: TrackingStatus;
  transition: TrackingTransition | null;
  /** World matrix for the anchor group when a fresh pose exists this frame; otherwise null (keep last). */
  anchorMatrix: Mat4 | null;
  /** Whether anchored content should be drawn this frame. */
  visible: boolean;
  measuredWidthMeters: number | null;
}

/**
 * Per-frame image-anchor logic shared by the probe and the future public Android image runtime:
 * adapter results → tracking state machine → composed anchor pose → visibility, plus width stats.
 * Rendering (three.js) stays outside.
 */
export class ImageAnchorTracker {
  readonly state: TrackingStateMachine;
  readonly widths = new WidthStats();
  /**
   * Raw per-frame counts (UA result state, not our hysteresis state). Lets a report show whether the
   * target ever left view: `emulated` / `noResult` frames after acquisition, and frames without a pose.
   */
  readonly counts = { frames: 0, tracked: 0, emulated: 0, noResult: 0, resultWithoutPose: 0, visible: 0 };
  private hasPose = false;
  private readonly api: ImageTrackingApi;
  private readonly targetIndex: number;
  private readonly correction: Mat4;

  constructor(api: ImageTrackingApi, opts: { targetIndex?: number; lostAfterFrames?: number; correction?: Mat4 } = {}) {
    this.api = api;
    this.targetIndex = opts.targetIndex ?? 0;
    this.correction = opts.correction ?? IMAGE_FRAME_CORRECTION;
    this.state = new TrackingStateMachine(opts.lostAfterFrames ?? 15);
  }

  onFrame(frame: PoseFrame & object, refSpace: XRSpace | null): FrameUpdate {
    const r = resultForIndex(this.api.getResults(frame), this.targetIndex);
    const transition = this.state.update(r?.trackingState ?? null);
    let anchorMatrix: Mat4 | null = null;
    let measuredWidthMeters: number | null = null;
    if (r) {
      measuredWidthMeters = r.measuredWidthInMeters;
      this.widths.add(r.measuredWidthInMeters);
      const pose = refSpace ? frame.getPose(r.imageSpace, refSpace) : null;
      if (pose) {
        anchorMatrix = composeAnchor(pose.transform.matrix, this.correction);
        this.hasPose = true;
      }
    }
    if (!this.state.contentVisible) this.hasPose = false; // re-acquire before showing again after `lost`
    const visible = this.state.contentVisible && this.hasPose;
    const c = this.counts;
    c.frames++;
    if (!r) c.noResult++;
    else {
      c[r.trackingState]++;
      if (!anchorMatrix) c.resultWithoutPose++;
    }
    if (visible) c.visible++;
    return { status: this.state.status, transition, anchorMatrix, visible, measuredWidthMeters };
  }
}

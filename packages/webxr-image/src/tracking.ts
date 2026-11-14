import type { XRImageTrackingState } from './types.ts';

/**
 * Per-frame tracking status (DESIGN.md states: scanning / acquired / lost; plus `emulated` from the UA).
 *  scanning → nothing seen yet in this session
 *  tracked  → UA reports a live pose
 *  emulated → UA reports an estimated (not currently observed) pose — content shown, flagged
 *  lost     → previously seen, no result for `lostAfterFrames` consecutive frames
 * A short gap below the threshold keeps the previous status to avoid flicker.
 */
export type TrackingStatus = 'scanning' | 'tracked' | 'emulated' | 'lost';

export interface TrackingTransition {
  from: TrackingStatus;
  to: TrackingStatus;
  frame: number;
}

export class TrackingStateMachine {
  status: TrackingStatus = 'scanning';
  private frame = 0;
  private missing = 0;
  readonly lostAfterFrames: number;

  constructor(lostAfterFrames = 15) {
    if (!(lostAfterFrames >= 1)) throw new Error('lostAfterFrames must be >= 1');
    this.lostAfterFrames = lostAfterFrames;
  }

  /** Feed one XR frame. Returns the transition when the status changed. */
  update(state: XRImageTrackingState | null): TrackingTransition | null {
    this.frame++;
    let next: TrackingStatus = this.status;
    if (state === 'tracked' || state === 'emulated') {
      this.missing = 0;
      next = state;
    } else {
      this.missing++;
      if (this.status !== 'scanning' && this.missing >= this.lostAfterFrames) next = 'lost';
    }
    if (next === this.status) return null;
    const t = { from: this.status, to: next, frame: this.frame };
    this.status = next;
    return t;
  }

  /** Whether anchored content should be drawn this frame. */
  get contentVisible(): boolean {
    return this.status === 'tracked' || this.status === 'emulated';
  }
}

/** Running stats for the UA-measured printed width vs the registered width (physical-size check). */
export class WidthStats {
  private values: number[] = [];
  add(w: number) {
    if (Number.isFinite(w) && w > 0) this.values.push(w);
  }
  /**
   * `echoesRegistered`: every sample equals the registered width (to float32 precision). Observed on
   * Chrome 157 / ARCore (2026-11-14, 478 samples): the UA reports back the width we supplied, so the
   * value is NOT an independent physical measurement and must not be used as size evidence.
   */
  summary(registeredMeters: number) {
    if (this.values.length === 0) return null;
    const s = [...this.values].sort((a, b) => a - b);
    const median = s[Math.floor(s.length / 2)]!;
    const reg32 = Math.fround(registeredMeters);
    const echoesRegistered = s.every((v) => Math.abs(v - reg32) <= 1e-6);
    return {
      samples: s.length,
      min: s[0]!,
      max: s[s.length - 1]!,
      median,
      distinctValues: new Set(s).size,
      ratioToRegistered: median / registeredMeters,
      echoesRegistered,
      usableAsSizeEvidence: !echoesRegistered,
    };
  }
}

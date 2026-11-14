import type {
  FrameLike,
  ImageTrackingSessionInit,
  SessionLike,
  XRImageTrackingResult,
  XRImageTrackingScore,
  XRTrackedImageInit,
} from './types.ts';

/**
 * Capability adapter for native WebXR image/marker tracking (PLATFORM_ROUTING.md "Android image tracking").
 * Exactly one API shape is implemented: Chrome's `image-tracking` (trackedImages + getTrackedImageScores +
 * getImageTrackingResults). Anything else — including the evolving `marker-tracking` drafts — is reported as
 * `unavailable` with diagnostics; we never guess at an unverified syntax or fall back to a JS tracker.
 */
export interface ImageTrackingApi {
  kind: 'chrome-image-tracking';
  getScores(): Promise<readonly XRImageTrackingScore[]>;
  /** Accepts any XRFrame; the experimental method is probed structurally. */
  getResults(frame: object): readonly XRImageTrackingResult[];
}

export type ApiResolution =
  | { ok: true; api: ImageTrackingApi }
  | { ok: false; reason: UnavailableReason; enabledFeatures: readonly string[] | null };

export type UnavailableReason =
  /** Session started but the UA did not grant image tracking (most often: flag off or unsupported device). */
  | 'feature-not-granted'
  /** UA granted a tracking-related feature whose API shape this adapter does not implement. */
  | 'unrecognized-api';

export const IMAGE_TRACKING_FEATURE = 'image-tracking';
export const MARKER_TRACKING_FEATURE = 'marker-tracking';

/**
 * Session init: image tracking and DOM overlay are OPTIONAL so the session still starts when they are
 * missing; that lets the probe distinguish "no immersive-ar" from "immersive-ar without image tracking".
 */
export function buildSessionInit(targets: XRTrackedImageInit[], overlayRoot?: Element): ImageTrackingSessionInit {
  if (targets.length === 0) throw new Error('at least one tracked image is required');
  for (const t of targets) {
    if (!(t.widthInMeters > 0 && t.widthInMeters <= 5)) throw new Error(`implausible widthInMeters ${t.widthInMeters}`);
  }
  const init: ImageTrackingSessionInit = {
    requiredFeatures: ['local'],
    optionalFeatures: [IMAGE_TRACKING_FEATURE, ...(overlayRoot ? ['dom-overlay'] : [])],
    trackedImages: targets,
  };
  if (overlayRoot) init.domOverlay = { root: overlayRoot };
  return init;
}

export function resolveImageTrackingApi(session: SessionLike): ApiResolution {
  const enabled = Array.isArray(session.enabledFeatures) ? session.enabledFeatures : null;
  const hasScores = typeof session.getTrackedImageScores === 'function';
  // Older Chrome builds lack `enabledFeatures`; then the method's presence is the only signal.
  const granted = enabled ? enabled.includes(IMAGE_TRACKING_FEATURE) : hasScores;
  if (granted && hasScores) {
    return {
      ok: true,
      api: {
        kind: 'chrome-image-tracking',
        getScores: () => session.getTrackedImageScores!(),
        getResults: (frame) => {
          const f = frame as FrameLike;
          return typeof f.getImageTrackingResults === 'function' ? f.getImageTrackingResults() : [];
        },
      },
    };
  }
  if (enabled?.includes(MARKER_TRACKING_FEATURE) || (granted && !hasScores)) {
    return { ok: false, reason: 'unrecognized-api', enabledFeatures: enabled };
  }
  return { ok: false, reason: 'feature-not-granted', enabledFeatures: enabled };
}

/** Pick the result for a given target index (one target per experience today). */
export function resultForIndex(results: readonly XRImageTrackingResult[], index: number): XRImageTrackingResult | null {
  return results.find((r) => r.index === index) ?? null;
}

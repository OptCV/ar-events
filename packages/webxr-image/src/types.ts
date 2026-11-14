/**
 * Local typings for Chrome's experimental WebXR image tracking (behind chrome://flags "WebXR Incubations").
 * Draft: https://immersive-web.github.io/image-tracking/ — the deployed Chrome shape may differ from the draft,
 * so these types are deliberately NOT global augmentations; only the adapter touches them.
 */
export interface XRTrackedImageInit {
  image: ImageBitmap;
  widthInMeters: number;
}

export type XRImageTrackingScore = 'untrackable' | 'trackable';
export type XRImageTrackingState = 'tracked' | 'emulated';

export interface XRImageTrackingResult {
  readonly imageSpace: XRSpace;
  readonly index: number;
  readonly trackingState: XRImageTrackingState;
  readonly measuredWidthInMeters: number;
}

/** Minimal session/frame surfaces the adapter inspects (structural, so tests can fake them). */
export interface SessionLike {
  enabledFeatures?: readonly string[];
  domOverlayState?: { type?: string } | null;
  getTrackedImageScores?: () => Promise<readonly XRImageTrackingScore[]>;
}
export interface FrameLike {
  getImageTrackingResults?: () => readonly XRImageTrackingResult[];
}

export type ImageTrackingSessionInit = XRSessionInit & {
  trackedImages?: XRTrackedImageInit[];
  domOverlay?: { root: Element };
};

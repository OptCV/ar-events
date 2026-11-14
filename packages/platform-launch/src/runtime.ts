import type { PlacementMode } from '@ar-creator/schema';

/** Runtime identifiers shared with the capability registry (CAPABILITIES.md). */
export const RUNTIMES = [
  'ios_quicklook_image',
  'ios_quicklook_floor',
  'ios_quicklook_wall',
  'android_webxr_image',
  'android_scene_viewer_floor',
  'android_scene_viewer_wall',
] as const;
export type Runtime = (typeof RUNTIMES)[number];

export type ResolvedRuntime =
  | { kind: 'native'; runtime: Runtime }
  | { kind: 'preview'; reason: 'desktop' | 'unsupported-browser' | 'webxr-image-tracking-unavailable' };

export interface DeviceEnv {
  /** Platform family detected from UA/feature probes. */
  os: 'ios' | 'android' | 'other';
  /** iOS: `a.relList.supports('ar')`. */
  quickLookSupported?: boolean;
  /**
   * Android image mode only: result of an actual WebXR probe (immersive-ar supported AND
   * an image tracking feature granted). Undefined = not yet probed → still route to the WebXR start UI,
   * which will run the probe after the user gesture.
   */
  webxrImageTracking?: boolean;
}

/**
 * The single, central placement × platform mapping (PLATFORM_ROUTING.md, ADR-002):
 *  image:  iOS → Quick Look image anchor; Android → experimental WebXR (never Scene Viewer)
 *  floor:  iOS → Quick Look horizontal;   Android → Scene Viewer
 *  wall:   iOS → Quick Look vertical;     Android → Scene Viewer + enable_vertical_placement
 */
export function resolveRuntime(mode: PlacementMode, env: DeviceEnv): ResolvedRuntime {
  if (env.os === 'ios') {
    if (env.quickLookSupported === false) return { kind: 'preview', reason: 'unsupported-browser' };
    return { kind: 'native', runtime: `ios_quicklook_${mode}` };
  }
  if (env.os === 'android') {
    if (mode === 'image') {
      if (env.webxrImageTracking === false) return { kind: 'preview', reason: 'webxr-image-tracking-unavailable' };
      return { kind: 'native', runtime: 'android_webxr_image' };
    }
    return { kind: 'native', runtime: mode === 'floor' ? 'android_scene_viewer_floor' : 'android_scene_viewer_wall' };
  }
  return { kind: 'preview', reason: 'desktop' };
}

/** Coarse UA classification. iPadOS 13+ reports as Mac, so touch support is used as a tie-breaker. */
export function detectOs(userAgent: string, maxTouchPoints = 0): DeviceEnv['os'] {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return 'ios';
  return 'other';
}

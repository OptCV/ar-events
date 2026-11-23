import { buildQuickLookHref } from './quickLook.ts';
import { LaunchParamError, buildSceneViewerIntent } from './sceneViewer.ts';
import type { DeviceEnv } from './runtime.ts';

/**
 * "View in AR" for a single generated object (ADR-026): the object is placed on the floor, so the central routing
 * applies as for floor experiences — iOS → AR Quick Look (USDZ, `<a rel="ar">`), Android → Scene Viewer (GLB, floor).
 * The image-tracking runtime is never used here; that needs an experience with a tracking image.
 */
export interface ViewInArInput {
  /** Signed HTTPS URLs of the two generated files (cookieless, so native viewers can fetch them). */
  usdzUrl: string | null;
  glbUrl: string | null;
  /** Page Scene Viewer opens when it cannot start (no Google app / ARCore). HTTPS. */
  fallbackUrl: string;
  title?: string;
}

export type ViewInAr =
  | { kind: 'quick-look'; href: string }
  | { kind: 'scene-viewer'; href: string }
  | { kind: 'unavailable'; reason: 'desktop' | 'no-quick-look' | 'missing-file' | 'needs-https' };

export function viewInAr(env: DeviceEnv, input: ViewInArInput): ViewInAr {
  if (env.os === 'other') return { kind: 'unavailable', reason: 'desktop' };
  if (env.os === 'ios' && env.quickLookSupported === false) return { kind: 'unavailable', reason: 'no-quick-look' };
  const file = env.os === 'ios' ? input.usdzUrl : input.glbUrl;
  if (!file) return { kind: 'unavailable', reason: 'missing-file' };
  try {
    if (env.os === 'ios') return { kind: 'quick-look', href: buildQuickLookHref({ usdzUrl: file }) };
    return {
      kind: 'scene-viewer',
      href: buildSceneViewerIntent({ placement: 'floor', fileUrl: file, browserFallbackUrl: input.fallbackUrl, ...(input.title ? { title: input.title } : {}) }),
    };
  } catch (e) {
    if (e instanceof LaunchParamError) return { kind: 'unavailable', reason: 'needs-https' };
    throw e;
  }
}

/**
 * Pre-session checks and user-facing error mapping. None of these prove image tracking works:
 * `immersive-ar` support says nothing about the image-tracking feature, which is only knowable
 * after a user-initiated session starts (see resolveImageTrackingApi).
 */
export interface PreflightEnv {
  isSecureContext: boolean;
  /** isSessionSupported can hang when no XR runtime answers (seen in headless Chromium). Default 4000 ms. */
  timeoutMs?: number;
  xr?: { isSessionSupported(mode: XRSessionMode): Promise<boolean> } | undefined;
}

export interface PreflightResult {
  secureContext: boolean;
  webxr: boolean;
  immersiveAr: boolean | 'error';
  canAttempt: boolean;
  messages: string[];
}

export async function preflight(env: PreflightEnv): Promise<PreflightResult> {
  const messages: string[] = [];
  const webxr = !!env.xr;
  let immersiveAr: boolean | 'error' = false;
  if (!env.isSecureContext) messages.push('This page must be served over HTTPS for WebXR and camera access.');
  if (!webxr) messages.push('This browser does not expose WebXR (navigator.xr). Use Chrome on an ARCore-supported Android device.');
  else {
    try {
      immersiveAr = await withTimeout(env.xr!.isSessionSupported('immersive-ar'), env.timeoutMs ?? 4000);
      if (!immersiveAr) messages.push('This device/browser does not support immersive AR sessions (ARCore / Google Play Services for AR required).');
    } catch {
      immersiveAr = 'error';
      messages.push('Checking AR support failed or timed out (it may be blocked by a permissions policy or no AR runtime responded).');
    }
  }
  return { secureContext: env.isSecureContext, webxr, immersiveAr, canAttempt: env.isSecureContext && immersiveAr === true, messages };
}

export const FLAG_HELP =
  'Image tracking requires a supported Android Chrome configuration. To try it, open chrome://flags, enable “WebXR Incubations”, ' +
  'relaunch Chrome and reload this page. You can still preview this experience in 3D.';

export function describeStartError(e: unknown): string {
  const name = e instanceof Error || (typeof e === 'object' && e !== null && 'name' in e) ? String((e as { name: unknown }).name) : '';
  switch (name) {
    case 'NotSupportedError':
      return 'AR session could not be created with these features on this device.';
    case 'SecurityError':
      return 'AR was blocked: the session must start from a tap on this HTTPS page.';
    case 'NotAllowedError':
      return 'Camera or AR permission was denied.';
    case 'InvalidStateError':
      return 'Another AR session is already running.';
    default:
      return `AR session failed to start${name ? ` (${name})` : ''}.`;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

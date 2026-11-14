import { checkHostedAssetUrl, checkOutboundUrl } from '@ar-creator/schema';

/**
 * Google Scene Viewer explicit intent builder — the ONLY place Android floor/wall launch URLs are made.
 * Reference: https://developers.google.com/ar/develop/scene-viewer
 *
 * Target: Google app (com.google.android.googlequicksearchbox) with mode=ar_preferred. Using
 * `ar_only` against this package is forbidden by PLATFORM_ROUTING.md (it belongs to com.google.ar.core
 * with different parameters and requires an ADR).
 */
export const SCENE_VIEWER_PACKAGE = 'com.google.android.googlequicksearchbox';
export const SCENE_VIEWER_BASE = 'arvr.google.com/scene-viewer/1.0';

export interface SceneViewerParams {
  placement: 'floor' | 'wall';
  /** Public HTTPS URL of the composed, self-contained GLB. Never a blob:/data: URL. */
  fileUrl: string;
  /** HTTPS page opened if the intent cannot be handled (e.g. no Google app / no ARCore). */
  browserFallbackUrl: string;
  title?: string;
  /** One primary https CTA; Scene Viewer shows it natively. Additional links live on the landing page. */
  link?: string;
  /** Default true in Scene Viewer. false only when the creator explicitly requests fixed scale. */
  resizable?: boolean;
}

export class LaunchParamError extends Error {
  override name = 'LaunchParamError';
  readonly param: string;
  constructor(param: string, reason: string) {
    super(`${param}: ${reason}`);
    this.param = param;
  }
}

const TITLE_MAX = 60;

function requireHttps(param: string, value: string): string {
  const r = checkHostedAssetUrl(value);
  if (!r.ok) throw new LaunchParamError(param, r.reason);
  return r.url.href;
}

export function buildSceneViewerIntent(p: SceneViewerParams): string {
  if (p.placement !== 'floor' && p.placement !== 'wall') {
    // Image-anchored Android experiences use experimental WebXR, never Scene Viewer (ADR-002).
    throw new LaunchParamError('placement', `Scene Viewer is only used for floor/wall, got ${String(p.placement)}`);
  }
  const query: [string, string][] = [
    ['file', requireHttps('fileUrl', p.fileUrl)],
    ['mode', 'ar_preferred'],
  ];
  if (p.title !== undefined) {
    const title = p.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TITLE_MAX);
    if (title) query.push(['title', title]);
  }
  if (p.link !== undefined) {
    const r = checkOutboundUrl(p.link, ['https:']);
    if (!r.ok) throw new LaunchParamError('link', r.reason);
    query.push(['link', r.url.href]);
  }
  if (p.resizable === false) query.push(['resizable', 'false']);
  if (p.placement === 'wall') query.push(['enable_vertical_placement', 'true']);

  const fallback = requireHttps('browserFallbackUrl', p.browserFallbackUrl);
  // encodeURIComponent escapes ; # & = so values cannot break out of the query or the #Intent block.
  const qs = query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return (
    `intent://${SCENE_VIEWER_BASE}?${qs}` +
    `#Intent;scheme=https;package=${SCENE_VIEWER_PACKAGE};action=android.intent.action.VIEW;` +
    `S.browser_fallback_url=${encodeURIComponent(fallback)};end;`
  );
}

/** Parse an intent produced by buildSceneViewerIntent (used by tests and diagnostics UI). */
export function parseSceneViewerIntent(intent: string): { query: Record<string, string>; extras: Record<string, string> } {
  const m = /^intent:\/\/([^?#]+)\?([^#]*)#Intent;(.*)end;$/.exec(intent);
  if (!m) throw new Error('not a Scene Viewer intent');
  const query: Record<string, string> = {};
  for (const part of m[2]!.split('&')) {
    const [k, v = ''] = part.split('=');
    query[k!] = decodeURIComponent(v);
  }
  const extras: Record<string, string> = {};
  for (const part of m[3]!.split(';').filter(Boolean)) {
    const i = part.indexOf('=');
    extras[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return { query, extras };
}

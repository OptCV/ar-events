import { describe, expect, it } from 'vitest';
import {
  LaunchParamError,
  QUICK_LOOK_TAP_MESSAGE,
  buildQuickLookHref,
  buildSceneViewerIntent,
  detectOs,
  onQuickLookTap,
  parseSceneViewerIntent,
  resolveRuntime,
} from './index.ts';

const base = {
  fileUrl: 'https://cdn.example.com/experiences/e1/revisions/r1/android/experience.glb',
  browserFallbackUrl: 'https://ar.example.com/x/my-exp',
};

describe('buildSceneViewerIntent', () => {
  it('floor: ar_preferred, Google app package, fallback, no vertical flag', () => {
    const intent = buildSceneViewerIntent({ ...base, placement: 'floor', title: 'Chair', link: 'https://shop.example.com/c?id=1&x=2' });
    const { query, extras } = parseSceneViewerIntent(intent);
    expect(query).toEqual({ file: base.fileUrl, mode: 'ar_preferred', title: 'Chair', link: 'https://shop.example.com/c?id=1&x=2' });
    expect(query.enable_vertical_placement).toBeUndefined();
    expect(extras).toMatchObject({
      scheme: 'https',
      package: 'com.google.android.googlequicksearchbox',
      action: 'android.intent.action.VIEW',
      'S.browser_fallback_url': base.browserFallbackUrl,
    });
    expect(intent.startsWith('intent://arvr.google.com/scene-viewer/1.0?')).toBe(true);
  });

  it('wall: sets enable_vertical_placement=true', () => {
    const { query } = parseSceneViewerIntent(buildSceneViewerIntent({ ...base, placement: 'wall' }));
    expect(query.enable_vertical_placement).toBe('true');
  });

  it('resizable=false only when fixed scale requested', () => {
    expect(parseSceneViewerIntent(buildSceneViewerIntent({ ...base, placement: 'floor' })).query.resizable).toBeUndefined();
    expect(parseSceneViewerIntent(buildSceneViewerIntent({ ...base, placement: 'floor', resizable: false })).query.resizable).toBe('false');
  });

  it('refuses image placement (Android image uses WebXR, never Scene Viewer)', () => {
    expect(() => buildSceneViewerIntent({ ...base, placement: 'image' as never })).toThrow(LaunchParamError);
  });

  it('refuses blob:, data:, http: file URLs and non-https links', () => {
    for (const fileUrl of ['blob:https://ar.example.com/abc', 'data:model/gltf-binary;base64,AA', 'http://cdn.example.com/a.glb']) {
      expect(() => buildSceneViewerIntent({ ...base, placement: 'floor', fileUrl })).toThrow(/fileUrl/);
    }
    expect(() => buildSceneViewerIntent({ ...base, placement: 'floor', link: 'javascript:alert(1)' })).toThrow(/link/);
  });

  it('cannot be broken out of by delimiter injection', () => {
    const hostile = 'x;end;#Intent;package=evil;S.browser_fallback_url=https://evil.example&mode=ar_only';
    const intent = buildSceneViewerIntent({ ...base, placement: 'floor', title: hostile, link: `https://shop.example.com/?q=${hostile}` });
    expect(intent.match(/#Intent;/g)).toHaveLength(1);
    expect(intent.match(/;end;/g)).toHaveLength(1);
    const { query, extras } = parseSceneViewerIntent(intent);
    expect(query.mode).toBe('ar_preferred');
    expect(extras.package).toBe('com.google.android.googlequicksearchbox');
    expect(extras['S.browser_fallback_url']).toBe(base.browserFallbackUrl);
  });
});

describe('buildQuickLookHref', () => {
  it('plain usdz href without params', () => {
    expect(buildQuickLookHref({ usdzUrl: 'https://cdn.example.com/a.usdz' })).toBe('https://cdn.example.com/a.usdz');
  });
  it('encodes banner params into the fragment', () => {
    const href = buildQuickLookHref({
      usdzUrl: 'https://cdn.example.com/a.usdz#old',
      callToAction: 'Shop & learn',
      checkoutTitle: 'Lamp',
      allowsContentScaling: false,
      canonicalWebPageUrl: 'https://ar.example.com/x/lamp',
    });
    const frag = new URLSearchParams(new URL(href).hash.slice(1));
    expect(frag.get('callToAction')).toBe('Shop & learn');
    expect(frag.get('checkoutTitle')).toBe('Lamp');
    expect(frag.get('allowsContentScaling')).toBe('0');
    expect(frag.get('canonicalWebPageURL')).toBe('https://ar.example.com/x/lamp');
    expect(href.startsWith('https://cdn.example.com/a.usdz#')).toBe(true);
  });
  it('rejects non-https usdz', () => {
    expect(() => buildQuickLookHref({ usdzUrl: 'blob:https://x/y' })).toThrow(LaunchParamError);
  });
  it('onQuickLookTap only reacts to the Apple message', () => {
    const target = new EventTarget() as unknown as HTMLAnchorElement;
    const opened: string[] = [];
    const dispose = onQuickLookTap(target, 'https://shop.example.com', (u) => opened.push(u));
    target.dispatchEvent(new MessageEvent('message', { data: 'something-else' }));
    target.dispatchEvent(new MessageEvent('message', { data: QUICK_LOOK_TAP_MESSAGE }));
    dispose();
    target.dispatchEvent(new MessageEvent('message', { data: QUICK_LOOK_TAP_MESSAGE }));
    expect(opened).toEqual(['https://shop.example.com/']);
  });
});

describe('resolveRuntime (ADR-002 mapping)', () => {
  it('maps every placement × platform', () => {
    expect(resolveRuntime('image', { os: 'ios' })).toEqual({ kind: 'native', runtime: 'ios_quicklook_image' });
    expect(resolveRuntime('floor', { os: 'ios' })).toEqual({ kind: 'native', runtime: 'ios_quicklook_floor' });
    expect(resolveRuntime('wall', { os: 'ios' })).toEqual({ kind: 'native', runtime: 'ios_quicklook_wall' });
    expect(resolveRuntime('image', { os: 'android' })).toEqual({ kind: 'native', runtime: 'android_webxr_image' });
    expect(resolveRuntime('floor', { os: 'android' })).toEqual({ kind: 'native', runtime: 'android_scene_viewer_floor' });
    expect(resolveRuntime('wall', { os: 'android' })).toEqual({ kind: 'native', runtime: 'android_scene_viewer_wall' });
  });
  it('never falls back from Android image to Scene Viewer', () => {
    expect(resolveRuntime('image', { os: 'android', webxrImageTracking: false })).toEqual({
      kind: 'preview',
      reason: 'webxr-image-tracking-unavailable',
    });
  });
  it('desktop and non-Quick-Look iOS browsers get preview', () => {
    expect(resolveRuntime('floor', { os: 'other' }).kind).toBe('preview');
    expect(resolveRuntime('floor', { os: 'ios', quickLookSupported: false }).kind).toBe('preview');
  });
  it('detectOs handles iPadOS desktop UA', () => {
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios');
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('other');
    expect(detectOs('Mozilla/5.0 (Linux; Android 15; Pixel 9)')).toBe('android');
  });
});

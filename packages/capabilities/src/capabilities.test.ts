import { describe, expect, it } from 'vitest';
import { RUNTIMES } from '@ar-creator/platform-launch';
import { FEATURES, capability, compatibilityReport } from './index.ts';

describe('capability registry', () => {
  it('defines every feature for every runtime with a message', () => {
    for (const f of FEATURES)
      for (const r of RUNTIMES) {
        const e = capability(f, r);
        expect(e.message.length, `${f}/${r}`).toBeGreaterThan(0);
      }
  });

  it('encodes the non-negotiable routing invariants', () => {
    expect(capability('image_target_recognition', 'android_scene_viewer_floor').status).toBe('unsupported');
    expect(capability('image_target_recognition', 'android_webxr_image').status).toBe('experimental');
    for (const r of ['ios_quicklook_floor', 'android_scene_viewer_wall'] as const) {
      expect(capability('html_overlay', r).status).toBe('unsupported');
      expect(capability('additional_links', r).fallback).toBe('landing_page');
      expect(capability('hotspots', r).fallback).toBe('landing_page');
    }
    for (const r of RUNTIMES) expect(capability('creator_js', r).status).toBe('unsupported');
  });

  it('every non-native, non-verify entry declares a fallback or is explicitly experimental', () => {
    for (const f of FEATURES)
      for (const r of RUNTIMES) {
        const e = capability(f, r);
        if (e.status === 'fallback_page' || e.status === 'unsupported' || e.status === 'compiled_visual') {
          expect(e.fallback, `${f}/${r}`).toBeDefined();
        }
      }
  });

  it('no entry claims device verification yet (no evidence recorded)', () => {
    for (const f of FEATURES) for (const r of RUNTIMES) expect(capability(f, r).lastDeviceVerified).toBeUndefined();
  });

  it('compatibility report surfaces every non-native item', () => {
    const report = compatibilityReport(['hotspots', 'additional_links']);
    expect(report.some((i) => i.runtime === 'ios_quicklook_wall' && i.feature === 'hotspots')).toBe(true);
    expect(report.length).toBe(2 * RUNTIMES.length);
  });
});

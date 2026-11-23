import { describe, expect, it } from 'vitest';
import { parseSceneViewerIntent, viewInAr } from './index.ts';

const signed = (f: string) => `https://ar-creator-dev.example.workers.dev/api/derivatives/d1/content?exp=1700000000&sig=a%2Bb&kind=${f}`;
const input = { usdzUrl: signed('usdz'), glbUrl: signed('glb'), fallbackUrl: 'https://ar-creator-dev.example.workers.dev/library/a1/ar-object?ar=unavailable', title: 'Ring · 40 cm' };

describe('viewInAr (ADR-026)', () => {
  it('iOS → Quick Look on the signed USDZ URL, unchanged (no fragment)', () => {
    expect(viewInAr({ os: 'ios', quickLookSupported: true }, input)).toEqual({ kind: 'quick-look', href: input.usdzUrl });
  });

  it('Android → Scene Viewer, floor, signed GLB URL survives intact inside the intent', () => {
    const r = viewInAr({ os: 'android' }, input);
    expect(r.kind).toBe('scene-viewer');
    const { query, extras } = parseSceneViewerIntent((r as { href: string }).href);
    expect(query).toEqual({ file: input.glbUrl, mode: 'ar_preferred', title: 'Ring · 40 cm' });
    expect(query.enable_vertical_placement).toBeUndefined();
    expect(extras['S.browser_fallback_url']).toBe(input.fallbackUrl);
  });

  it('is unavailable on desktop, in iOS browsers without Quick Look, without the file, or over http', () => {
    expect(viewInAr({ os: 'other' }, input)).toEqual({ kind: 'unavailable', reason: 'desktop' });
    expect(viewInAr({ os: 'ios', quickLookSupported: false }, input)).toEqual({ kind: 'unavailable', reason: 'no-quick-look' });
    expect(viewInAr({ os: 'android' }, { ...input, glbUrl: null })).toEqual({ kind: 'unavailable', reason: 'missing-file' });
    expect(viewInAr({ os: 'ios' }, { ...input, usdzUrl: 'http://localhost:5173/api/derivatives/d1/content' })).toEqual({ kind: 'unavailable', reason: 'needs-https' });
    expect(viewInAr({ os: 'android' }, { ...input, fallbackUrl: 'http://localhost/x' })).toEqual({ kind: 'unavailable', reason: 'needs-https' });
  });
});

import { describe, expect, it } from 'vitest';
import type { XrInteractions } from '@ar-creator/contracts';
import { effectOf, findClip, overlayButtons, tapTarget } from './interactions.ts';

const xr: XrInteractions = {
  actions: [
    { id: 'about', type: 'link', label: 'About', href: 'https://example.com/about' },
    { id: 'shop', type: 'link', label: 'Shop now', href: 'https://example.com/shop' },
    { id: 'mail', type: 'link', label: 'Send email', href: 'mailto:hi@example.com' },
    { id: 'tog', type: 'toggle-visibility', label: 'Show or hide', nodeId: 'lamp' },
    { id: 'spin', type: 'play-animation', label: 'Play animation', nodeId: 'robot', clip: 'Spin' },
  ],
  taps: { box: 'tog', pin: 'shop', robot: 'spin' },
  hotspots: ['pin'],
  primaryActionId: 'shop',
};

describe('WebXR image viewer interactions (M17)', () => {
  it('finds the tapped object by walking up from the hit mesh', () => {
    expect(tapTarget(['box-box', 'box', 'group'], xr)).toEqual({ nodeId: 'box', actionId: 'tog' });
    expect(tapTarget(['mesh_0', 'model-root', 'robot'], xr)).toEqual({ nodeId: 'robot', actionId: 'spin' });
    expect(tapTarget(['floor', 'content'], xr)).toBeNull();
  });

  it('maps actions to effects', () => {
    expect(effectOf('shop', xr)).toEqual({ kind: 'navigate', href: 'https://example.com/shop' });
    expect(effectOf('mail', xr)).toEqual({ kind: 'navigate', href: 'mailto:hi@example.com' });
    expect(effectOf('tog', xr)).toEqual({ kind: 'toggle', nodeId: 'lamp' });
    expect(effectOf('spin', xr)).toEqual({ kind: 'play', nodeId: 'robot', clip: 'Spin' });
    expect(effectOf('missing', xr)).toBeNull();
  });

  it('lists every link as an on-screen button, main button first; behaviours are not buttons', () => {
    expect(overlayButtons(xr)).toEqual([
      { actionId: 'shop', label: 'Shop now', primary: true },
      { actionId: 'about', label: 'About', primary: false },
      { actionId: 'mail', label: 'Send email', primary: false },
    ]);
    expect(overlayButtons({ ...xr, primaryActionId: null })[0]!.primary).toBe(false);
  });

  it('finds the clip for the target object (same model placed twice) and addresses unnamed clips by index', () => {
    const clips = [
      { name: 'Spin', targets: ['joint-a'] },
      { name: 'Spin', targets: ['joint-b'] },
      { name: '', targets: ['joint-b'] },
    ];
    expect(findClip(clips, 'Spin', new Set(['robot-2', 'joint-b']))).toBe(1);
    expect(findClip(clips, 'Spin', new Set(['robot', 'joint-a']))).toBe(0);
    expect(findClip(clips, '#2', new Set(['joint-b']))).toBe(2);
    expect(findClip(clips, 'Walk', new Set(['joint-a']))).toBeNull();
  });
});

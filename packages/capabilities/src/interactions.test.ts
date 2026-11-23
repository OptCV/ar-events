import { describe, expect, it } from 'vitest';
import { DraftExperienceScene, IDENTITY_TRANSFORM, type Action, type PlacementMode, type SceneNode } from '@ar-creator/schema';
import { buildQuickLookHref, buildSceneViewerIntent, parseSceneViewerIntent } from '@ar-creator/platform-launch';
import { RUNTIMES_FOR, featuresUsed, interactionIssues, nativeLaunchOptions, pagePlan, planInteractions } from './index.ts';

const n = (id: string, extra: Record<string, unknown> = {}): SceneNode => ({ id, kind: 'primitive', shape: 'box', name: id, transform: IDENTITY_TRANSFORM, visible: true, locked: false, ...extra }) as SceneNode;
const placement = (mode: PlacementMode) => (mode === 'image' ? { mode, trackingTargetAssetId: 't', physicalWidthMeters: 0.2 } : { mode });
const ACTIONS: Action[] = [
  { id: 'web', type: 'open-url', url: 'https://example.com/shop', label: 'Shop now' },
  { id: 'web2', type: 'open-url', url: 'https://example.com/about' },
  { id: 'mail', type: 'mailto', address: 'hi@example.com' },
  { id: 'tel', type: 'tel', number: '+1 555 0100' },
  { id: 'toggle', type: 'toggle-visibility', nodeId: 'box' },
  { id: 'anim', type: 'play-animation', nodeId: 'model', clip: 'Spin' },
];
const scene = (mode: PlacementMode, extra: Partial<{ nodes: SceneNode[]; actions: Action[]; primaryActionId: string }> = {}) => ({
  placement: placement(mode),
  nodes: extra.nodes ?? [n('box'), n('model', { kind: 'model', assetId: 'm' })],
  actions: extra.actions ?? ACTIONS,
  ...(extra.primaryActionId ? { primaryActionId: extra.primaryActionId } : {}),
});

describe('interaction plan (M13)', () => {
  it('main button: Quick Look banner, Scene Viewer link, WebXR overlay; always first on the page', () => {
    const s = scene('floor', { primaryActionId: 'web' });
    const ios = planInteractions(s, 'ios_quicklook_floor');
    const sv = planInteractions(s, 'android_scene_viewer_floor');
    const xr = planInteractions(scene('image', { primaryActionId: 'web' }), 'android_webxr_image');
    expect(ios.primary).toMatchObject({ url: 'https://example.com/shop', label: 'Shop now', route: { surface: 'native-button', status: 'verify' } });
    expect(sv.primary?.route.surface).toBe('native-button');
    expect(xr.primary?.route).toMatchObject({ surface: 'overlay-button', status: 'experimental' });
    expect(ios.page.map((p) => [p.label, p.primary])).toEqual([
      ['Shop now', true],
      ['Visit website', false],
      ['Send email', false],
      ['Call', false],
    ]);
    expect(planInteractions(scene('floor'), 'ios_quicklook_floor').primary).toBeNull();
  });

  it('feeds the native launchers: Quick Look callToAction and Scene Viewer link', () => {
    const s = scene('wall', { primaryActionId: 'web' });
    const ql = nativeLaunchOptions(planInteractions(s, 'ios_quicklook_wall'));
    const sv = nativeLaunchOptions(planInteractions(s, 'android_scene_viewer_wall'));
    expect(ql).toEqual({ callToAction: 'Shop now' });
    expect(buildQuickLookHref({ usdzUrl: 'https://cdn.example.com/x.usdz', ...ql })).toBe('https://cdn.example.com/x.usdz#callToAction=Shop%20now');
    const intent = buildSceneViewerIntent({ placement: 'wall', fileUrl: 'https://cdn.example.com/x.glb', browserFallbackUrl: 'https://ar.example.com/x', ...sv });
    expect(parseSceneViewerIntent(intent).query).toMatchObject({ link: 'https://example.com/shop', enable_vertical_placement: 'true' });
    expect(nativeLaunchOptions(planInteractions(scene('image', { primaryActionId: 'web' }), 'android_webxr_image'))).toEqual({});
  });

  it('links are always on the page; behaviours run only from taps in WebXR and never on request in native viewers', () => {
    const s = scene('floor', { nodes: [n('box', { actionId: 'toggle' }), n('model', { kind: 'model', assetId: 'm', actionId: 'anim' })] });
    const ios = planInteractions(s, 'ios_quicklook_floor');
    const by = (p: typeof ios, id: string) => p.actions.find((a) => a.actionId === id)!;
    expect(by(ios, 'mail').routes.map((r) => r.surface)).toEqual(['page']);
    expect(by(ios, 'toggle')).toMatchObject({ routes: [], unavailable: 'Quick Look cannot show or hide objects on request.' });
    expect(by(ios, 'anim').routes).toMatchObject([{ surface: 'auto-play', status: 'verify' }]);
    const xr = planInteractions({ ...s, placement: placement('image') }, 'android_webxr_image');
    expect(by(xr, 'toggle').routes).toMatchObject([{ surface: 'tap', status: 'experimental', note: 'Tapping “box”.' }]);
    expect(by(xr, 'mail').routes.map((r) => r.surface)).toEqual(['overlay-button', 'page']);
  });

  it('issues name the action or object and the viewers: unavailable, unused, taps, hotspots, animations', () => {
    const s = scene('floor', {
      nodes: [n('box', { actionId: 'toggle' }), n('pin', { kind: 'hotspot', actionId: 'web2', name: 'Info pin' }), n('model', { kind: 'model', assetId: 'm', actionId: 'anim' })],
      actions: [...ACTIONS, { id: 'lonely', type: 'toggle-visibility', nodeId: 'box' }],
    });
    expect(interactionIssues(s).map((i) => [i.code, i.message])).toEqual([
      ['action_unavailable', 'Show or hide “box” does not work in iPhone and iPad (Quick Look) and Android (Scene Viewer): Quick Look cannot show or hide objects on request.'],
      ['animation_not_on_request', 'Play “Spin” on “model” cannot be started by a tap in iPhone and iPad (Quick Look) and Android (Scene Viewer); the animation plays by itself there.'],
      ['action_unused', 'Show or hide “box” is not used by any object or hotspot, so it never runs.'],
      ['tap_not_supported', 'Tapping “box” does nothing in iPhone and iPad (Quick Look) and Android (Scene Viewer); the action is not available there.'],
      ['tap_not_supported', 'The hotspot “Info pin” is not shown in iPhone and iPad (Quick Look) and Android (Scene Viewer); its link is on the experience page instead.'],
      ['tap_not_supported', 'Tapping “model” does nothing in iPhone and iPad (Quick Look) and Android (Scene Viewer); the action is not available there.'],
    ]);
    // Image placement: taps work in WebXR, so only Quick Look is named.
    const img = interactionIssues({ ...s, placement: placement('image') });
    expect(img.find((i) => i.code === 'tap_not_supported')!.message).toBe('Tapping “box” does nothing in iPhone and iPad (Quick Look); the action is not available there.');
    expect(interactionIssues(scene('floor', { actions: ACTIONS.slice(0, 4) }))).toEqual([]); // links only: nothing to warn
  });

  it('lists the features a scene uses for the matrix', () => {
    expect(featuresUsed(scene('image', { primaryActionId: 'web', nodes: [n('box'), n('io', { kind: 'image-object', derivativeId: 'd' }), n('t', { kind: 'text', text: 'x', style: { color: '#000000', sizeMeters: 0.05 } }), n('h', { kind: 'hotspot', actionId: 'web' })] }), { blendImageObjects: 1 })).toEqual([
      'image_target_recognition', 'image_object_flat', 'semitransparency', 'text_panel', 'shape', 'hotspots', 'model_animation', 'primary_cta', 'additional_links',
    ]);
    expect(featuresUsed(scene('floor', { nodes: [], actions: [] }))).toEqual([]);
  });

  /**
   * THE PHASE 4 GATE: no action silently disappears. For every combination of placement, action kind, main button and
   * tap/hotspot use (all valid scenes), each action on each runtime has a route, or is unavailable AND an issue names
   * it for that runtime. Links are always on the page.
   */
  it('gate: every action is reachable or explained on every runtime (exhaustive over small scenes)', () => {
    let checked = 0;
    const uses: (readonly ('tap' | 'hotspot')[])[] = [[], ['tap'], ['hotspot'], ['tap', 'hotspot']];
    for (const mode of ['image', 'floor', 'wall'] as const)
      for (const a of ACTIONS)
        for (const u of uses)
          for (const primary of [false, true]) {
            if (primary && a.type !== 'open-url') continue;
            const nodes = [n('box', u.includes('tap') ? { actionId: a.id } : {}), n('model', { kind: 'model', assetId: 'm' }), ...(u.includes('hotspot') ? [n('pin', { kind: 'hotspot', actionId: a.id })] : [])];
            const s = scene(mode, { nodes, actions: [a], ...(primary ? { primaryActionId: a.id } : {}) });
            expect(DraftExperienceScene.safeParse({ schemaVersion: 1, ...s }).success).toBe(true);
            const issues = interactionIssues(s);
            for (const runtime of RUNTIMES_FOR[mode]) {
              const p = planInteractions(s, runtime).actions[0]!;
              const explained = issues.some((i) => i.path[0] === 'actions' && i.path[1] === 0 && i.runtimes.includes(runtime));
              expect(p.routes.length > 0 || (p.unavailable !== null && explained), `${mode}/${a.type}/${u.join('+')}/${primary}/${runtime}`).toBe(true);
              if (a.type === 'open-url' || a.type === 'mailto' || a.type === 'tel') expect(p.routes.some((r) => r.surface === 'page')).toBe(true);
              checked++;
            }
          }
    expect(checked).toBe(3 * (6 * 4 + 2 * 4) * 2); // 3 placements × (6 actions × 4 uses + 2 web links × 4 uses as main button) × 2 runtimes
    expect(pagePlan(scene('floor', { actions: [] }))).toEqual([]);
  });
});

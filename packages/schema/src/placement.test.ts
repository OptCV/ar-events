import { describe, expect, it } from 'vitest';
import { DraftExperienceScene, ExperienceScene, IDENTITY_TRANSFORM, defaultDraftScene, planPlacementChange, publishReadiness } from './index.ts';

const withNode = (mode: 'image' | 'floor' | 'wall') => ({
  ...defaultDraftScene(mode),
  nodes: [{ id: 'box', kind: 'primitive' as const, shape: 'box' as const, transform: IDENTITY_TRANSFORM, visible: true, locked: false }],
});

describe('draft vs publishable scene', () => {
  it('a new image-mode draft is a valid draft but not publishable', () => {
    const d = defaultDraftScene('image');
    expect(DraftExperienceScene.safeParse(d).success).toBe(true);
    expect(ExperienceScene.safeParse(d).success).toBe(false);
  });

  it('draft keeps all integrity rules (duplicate ids, cycles, hostile URLs)', () => {
    const base = defaultDraftScene('floor');
    const node = (id: string, parentId?: string) => ({ id, kind: 'group', transform: IDENTITY_TRANSFORM, ...(parentId ? { parentId } : {}) });
    expect(DraftExperienceScene.safeParse({ ...base, nodes: [node('a'), node('a')] }).success).toBe(false);
    expect(DraftExperienceScene.safeParse({ ...base, nodes: [node('a', 'b'), node('b', 'a')] }).success).toBe(false);
    expect(DraftExperienceScene.safeParse({ ...base, actions: [{ id: 'x', type: 'open-url', url: 'javascript:alert(1)' }] }).success).toBe(false);
  });

  it('draft image placement still validates the physical width', () => {
    expect(DraftExperienceScene.safeParse({ ...defaultDraftScene('image'), placement: { mode: 'image', trackingTargetAssetId: null, physicalWidthMeters: 20 } }).success).toBe(false);
  });
});

describe('planPlacementChange', () => {
  it('same mode → no change', () => {
    expect(planPlacementChange(withNode('floor'), 'floor')).toMatchObject({ changed: false, warnings: [] });
  });

  it('image → floor removes the target settings, keeps every node, and warns', () => {
    const scene = { ...withNode('image'), placement: { mode: 'image' as const, trackingTargetAssetId: 'asset_1', physicalWidthMeters: 0.25 } };
    const p = planPlacementChange(scene, 'floor');
    expect(p).toMatchObject({ from: 'image', to: 'floor', changed: true, placement: { mode: 'floor' } });
    expect(p.removed).toEqual(['tracking image', 'printed width (25 cm)']);
    expect(p.warnings.join(' ')).toMatch(/tracking image/);
    expect(p.warnings.join(' ')).toMatch(/All 1 object\(s\) and 0 action\(s\) are kept/);
  });

  it('floor → wall warns about the surface and object orientation', () => {
    const p = planPlacementChange(withNode('floor'), 'wall');
    expect(p.warnings.join(' ')).toMatch(/vertical surface/);
    expect(p.warnings.join(' ')).toMatch(/1 object will keep their positions/);
  });

  it('floor → image requires a tracking image before publishing', () => {
    const p = planPlacementChange(defaultDraftScene('floor'), 'image');
    expect(p.placement).toEqual({ mode: 'image', trackingTargetAssetId: null, physicalWidthMeters: 0.2 });
    expect(p.warnings.join(' ')).toMatch(/needs a tracking image/);
  });
});

describe('publishReadiness', () => {
  it('empty scene and missing target are errors; missing primary link is a warning', () => {
    const r = publishReadiness(defaultDraftScene('image'));
    expect(r.ready).toBe(false);
    expect(r.issues.map((i) => i.code).sort()).toEqual(['no_primary_action', 'scene_empty', 'tracking_image_missing']);
  });

  it('a floor scene with one object is ready (warning only)', () => {
    const r = publishReadiness(withNode('floor'));
    expect(r.ready).toBe(true);
    expect(r.issues.map((i) => i.severity)).toEqual(['warning']);
  });
});

describe('placement change copy', () => {
  it('only mentions the tracking image when one is set', () => {
    const none = planPlacementChange(defaultDraftScene('image'), 'wall');
    expect(none.warnings.join(' ')).not.toMatch(/tracking image and its printed width/);
    expect(none.warnings.join(' ')).toMatch(/printed-width setting/);
  });
});

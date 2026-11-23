import { describe, expect, it } from 'vitest';
import { ExperienceScene, IDENTITY_TRANSFORM, Placement, checkOutboundUrl } from './index.ts';

const base = { schemaVersion: 1, nodes: [], actions: [] } as const;

describe('Placement union', () => {
  it('roundtrips image, floor and wall', () => {
    for (const p of [
      { mode: 'image', trackingTargetAssetId: 'target_1', physicalWidthMeters: 0.2 },
      { mode: 'floor' },
      { mode: 'wall' },
    ]) {
      const parsed = Placement.parse(p);
      expect(Placement.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });

  it('rejects image mode without target or width', () => {
    expect(Placement.safeParse({ mode: 'image', physicalWidthMeters: 0.2 }).success).toBe(false);
    expect(Placement.safeParse({ mode: 'image', trackingTargetAssetId: 't' }).success).toBe(false);
  });

  it('rejects implausible physical widths (likely cm/m confusion)', () => {
    expect(Placement.safeParse({ mode: 'image', trackingTargetAssetId: 't', physicalWidthMeters: 20 }).success).toBe(false);
    expect(Placement.safeParse({ mode: 'image', trackingTargetAssetId: 't', physicalWidthMeters: 0.001 }).success).toBe(false);
  });

  it('floor/wall do not require a target', () => {
    expect(Placement.safeParse({ mode: 'wall' }).success).toBe(true);
  });
});

describe('ExperienceScene', () => {
  const node = (id: string, extra: object = {}) => ({ id, kind: 'group', transform: IDENTITY_TRANSFORM, ...extra });

  it('accepts a valid scene with a primary https action', () => {
    const r = ExperienceScene.safeParse({
      ...base,
      placement: { mode: 'floor' },
      nodes: [node('a'), node('b', { parentId: 'a', actionId: 'buy' })],
      actions: [{ id: 'buy', type: 'open-url', url: 'https://example.com/buy' }],
      primaryActionId: 'buy',
    });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('rejects non-normalized quaternions and non-positive scale', () => {
    expect(
      ExperienceScene.safeParse({ ...base, placement: { mode: 'floor' }, nodes: [node('a', { transform: { ...IDENTITY_TRANSFORM, rotation: [0, 0, 0, 2] } })] }).success,
    ).toBe(false);
    expect(
      ExperienceScene.safeParse({ ...base, placement: { mode: 'floor' }, nodes: [node('a', { transform: { ...IDENTITY_TRANSFORM, scale: [1, 0, 1] } })] }).success,
    ).toBe(false);
  });

  it('rejects duplicate ids, unknown parents and parent cycles', () => {
    const dup = ExperienceScene.safeParse({ ...base, placement: { mode: 'floor' }, nodes: [node('a'), node('a')] });
    expect(dup.success).toBe(false);
    const orphan = ExperienceScene.safeParse({ ...base, placement: { mode: 'floor' }, nodes: [node('a', { parentId: 'zz' })] });
    expect(orphan.success).toBe(false);
    const cycle = ExperienceScene.safeParse({
      ...base,
      placement: { mode: 'floor' },
      nodes: [node('a', { parentId: 'b' }), node('b', { parentId: 'a' })],
    });
    expect(cycle.success).toBe(false);
    expect(cycle.error?.issues.some((i) => i.message.includes('cycle'))).toBe(true);
  });

  it('rejects hostile action URLs', () => {
    for (const url of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', 'https://u:p@example.com', ' https://example.com']) {
      const r = ExperienceScene.safeParse({ ...base, placement: { mode: 'floor' }, actions: [{ id: 'x', type: 'open-url', url }] });
      expect(r.success, url).toBe(false);
    }
  });

  it('requires the primary native action to be an https link', () => {
    const r = ExperienceScene.safeParse({
      ...base,
      placement: { mode: 'floor' },
      actions: [{ id: 'm', type: 'mailto', address: 'hi@example.com' }],
      primaryActionId: 'm',
    });
    expect(r.success).toBe(false);
  });
});

describe('checkOutboundUrl', () => {
  it('allows https/mailto/tel only', () => {
    expect(checkOutboundUrl('https://example.com/a?b=c').ok).toBe(true);
    expect(checkOutboundUrl('mailto:a@example.com').ok).toBe(true);
    expect(checkOutboundUrl('tel:+15551234').ok).toBe(true);
    expect(checkOutboundUrl('JAVASCRIPT:alert(1)').ok).toBe(false);
    expect(checkOutboundUrl('intent://x#Intent;end').ok).toBe(false);
    expect(checkOutboundUrl('blob:https://example.com/uuid').ok).toBe(false);
    expect(checkOutboundUrl('https://exa\nmple.com').ok).toBe(false);
  });
});

describe('built-in content nodes (M11, ADR-029)', () => {
  const scene = (nodes: unknown[]) => ExperienceScene.safeParse({ ...base, placement: { mode: 'floor' }, nodes });
  const n = { transform: IDENTITY_TRANSFORM, visible: true, locked: false };
  it('accepts shapes with and without a colour (older scenes stay valid), text and panels; roundtrips them', () => {
    const nodes = [
      { ...n, id: 'p1', kind: 'primitive', shape: 'box' },
      { ...n, id: 'p2', kind: 'primitive', shape: 'sphere', color: '#ff8800' },
      { ...n, id: 't1', kind: 'text', text: 'Hello', style: { color: '#17202a', sizeMeters: 0.05 } },
      { ...n, id: 'g1', kind: 'panel', title: 'Title', body: 'Body' },
    ];
    const r = scene(nodes);
    expect(r.success).toBe(true);
    expect(JSON.parse(JSON.stringify(r.data!.nodes))).toEqual(nodes);
  });
  it('refuses bad colours, empty text and oversize text', () => {
    expect(scene([{ ...n, id: 'p', kind: 'primitive', shape: 'box', color: 'red' }]).success).toBe(false);
    expect(scene([{ ...n, id: 't', kind: 'text', text: '', style: { color: '#000000', sizeMeters: 0.05 } }]).success).toBe(false);
    expect(scene([{ ...n, id: 't', kind: 'text', text: 'x', style: { color: '#000000', sizeMeters: 3 } }]).success).toBe(false);
    expect(scene([{ ...n, id: 'p', kind: 'primitive', shape: 'cone' }]).success).toBe(false);
  });
});

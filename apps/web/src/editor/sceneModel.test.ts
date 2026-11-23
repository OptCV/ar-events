import { describe, expect, it } from 'vitest';
import { IDENTITY_TRANSFORM, type SceneNode } from '@ar-creator/schema';
import { effectivelyVisible, formatSize, nodeLabel, removeNode, setVisible, trackingImageSize, treeRows } from './sceneModel.ts';

const node = (id: string, extra: Partial<SceneNode> = {}): SceneNode =>
  ({ id, kind: 'group', transform: IDENTITY_TRANSFORM, visible: true, locked: false, ...extra }) as SceneNode;

describe('scene editor model', () => {
  it('orders the tree depth-first by parent, keeps sibling order and never drops orphans or cycles', () => {
    const nodes = [node('b', { parentId: 'a' }), node('a'), node('c'), node('d', { parentId: 'b' }), node('o', { parentId: 'missing' }), node('x', { parentId: 'y' }), node('y', { parentId: 'x' })];
    expect(treeRows(nodes).map((r) => `${r.node.id}:${r.depth}`)).toEqual(['a:0', 'b:1', 'd:2', 'c:0', 'o:0', 'x:0', 'y:0']);
  });

  it('hides descendants of a hidden node and toggles visibility immutably', () => {
    const nodes = [node('a', { visible: false }), node('b', { parentId: 'a' }), node('c')];
    expect(effectivelyVisible(nodes, 'b')).toBe(false);
    expect(effectivelyVisible(nodes, 'c')).toBe(true);
    const shown = setVisible(nodes, 'a', true);
    expect(effectivelyVisible(shown, 'b')).toBe(true);
    expect(nodes[0]!.visible).toBe(false);
  });

  it('removing a node keeps its children by moving them to its parent', () => {
    const nodes = [node('root'), node('mid', { parentId: 'root' }), node('leaf', { parentId: 'mid' }), node('top')];
    expect(removeNode(nodes, 'mid').map((n) => [n.id, n.parentId])).toEqual([['root', undefined], ['leaf', 'root'], ['top', undefined]]);
    expect(removeNode(nodes, 'root').find((n) => n.id === 'mid')).not.toHaveProperty('parentId');
  });

  it('sizes the tracking image from its printed width and pixel aspect ratio', () => {
    expect(trackingImageSize({ mode: 'image', trackingTargetAssetId: 'a', physicalWidthMeters: 0.2 }, { width: 1200, height: 800 })).toEqual({ width: 0.2, height: 0.2 * (800 / 1200) });
    expect(trackingImageSize({ mode: 'image', trackingTargetAssetId: null, physicalWidthMeters: 0.3 }, null)).toEqual({ width: 0.3, height: 0.3 });
    expect(trackingImageSize({ mode: 'floor' }, { width: 1, height: 1 })).toBeNull();
  });

  it('labels and formats sizes in centimetres', () => {
    expect(nodeLabel(node('a', { name: '  ' }))).toBe('Group');
    expect(nodeLabel({ ...node('a'), kind: 'image-object', derivativeId: 'd', name: 'ring.png' } as SceneNode)).toBe('ring.png');
    expect(formatSize([0.4, 0.4, 0.0001])).toBe('40 × 40 × 0 cm');
    expect(formatSize([0.123456, 1])).toBe('12.3 × 100 cm');
  });
});

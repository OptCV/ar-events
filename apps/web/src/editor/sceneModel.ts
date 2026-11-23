import type { DraftPlacement, SceneNode } from '@ar-creator/schema';

/**
 * Pure helpers for the scene editor (Phase 3 M9). The canonical scene (packages/schema) stays the only source of
 * truth; nothing here changes its meaning.
 */

export const KIND_LABEL: Record<SceneNode['kind'], string> = {
  group: 'Group',
  model: '3D model',
  'image-object': 'Image object',
  text: 'Text',
  panel: 'Panel',
  primitive: 'Shape',
  hotspot: 'Hotspot',
};

/** Node kinds the editor viewport can draw today; others are listed but not drawn yet. */
export const DRAWN_KINDS: ReadonlySet<SceneNode['kind']> = new Set(['image-object', 'model', 'text', 'panel', 'primitive']);

export function nodeLabel(n: SceneNode): string {
  return n.name?.trim() || KIND_LABEL[n.kind];
}

export interface TreeRow {
  node: SceneNode;
  depth: number;
}

/**
 * Depth-first tree order following `parentId`, keeping the stored order among siblings. Nodes whose parent is missing
 * (or that sit in a cycle, which the schema refuses anyway) are shown at the top level so nothing is ever hidden.
 */
export function treeRows(nodes: SceneNode[]): TreeRow[] {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string | undefined, SceneNode[]>();
  for (const n of nodes) {
    const parent = n.parentId !== undefined && ids.has(n.parentId) ? n.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), n]);
  }
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, depth: number) => {
    for (const n of children.get(parent) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      rows.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(undefined, 0);
  for (const n of nodes) if (!seen.has(n.id)) rows.push({ node: n, depth: 0 }); // cycles: never drop a node
  return rows;
}

/** A node and all its descendants are hidden when it or any ancestor has `visible: false`. */
export function effectivelyVisible(nodes: SceneNode[], id: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  for (let n = byId.get(id); n; n = n.parentId !== undefined ? byId.get(n.parentId) : undefined) {
    if (seen.has(n.id)) break;
    seen.add(n.id);
    if (n.visible === false) return false;
  }
  return true;
}

export function setVisible(nodes: SceneNode[], id: string, visible: boolean): SceneNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, visible } : n));
}

/** Removes a node; its children move up to the removed node's parent (content is never deleted implicitly). */
export function removeNode(nodes: SceneNode[], id: string): SceneNode[] {
  const target = nodes.find((n) => n.id === id);
  if (!target) return nodes;
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => {
      if (n.parentId !== id) return n;
      const { parentId: _drop, ...rest } = n;
      return (target.parentId !== undefined ? { ...rest, parentId: target.parentId } : rest) as SceneNode;
    });
}

/** Printed size of the tracking image in canonical meters: width as set, height from the image's aspect ratio. */
export function trackingImageSize(placement: DraftPlacement, pixels: { width: number; height: number } | null): { width: number; height: number } | null {
  if (placement.mode !== 'image') return null;
  const width = placement.physicalWidthMeters;
  return { width, height: pixels && pixels.width > 0 ? (width * pixels.height) / pixels.width : width };
}

export const cm = (m: number) => `${Number((m * 100).toFixed(1))} cm`;

/** "40 × 40 cm" (two axes) or "40 × 40 × 0 cm"; tiny depths of flat objects print as 0. */
export function formatSize(size: readonly number[]): string {
  return `${size.map((v) => Number((Math.abs(v) < 5e-4 ? 0 : v * 100).toFixed(1))).join(' × ')} cm`;
}

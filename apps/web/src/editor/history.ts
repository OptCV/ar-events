import type { SceneNode } from '@ar-creator/schema';

/**
 * Undo/redo for scene-editor edits (Phase 3 M10). It records the node list only: placement, tracking image and
 * details are not part of it, so undo never reverts those. Pure, so it is unit-tested; the editor keeps it in a ref.
 */
export interface History {
  past: SceneNode[][];
  future: SceneNode[][];
}

export const HISTORY_LIMIT = 100;
export const emptyHistory = (): History => ({ past: [], future: [] });

/** Record the node list as it was before an edit. A new edit clears redo. No-op edits are not recorded. */
export function record(h: History, before: SceneNode[], after: SceneNode[]): History {
  if (before === after || JSON.stringify(before) === JSON.stringify(after)) return h;
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), future: [] };
}

/** Step back: returns the node list to restore, or null when there is nothing to undo. */
export function undo(h: History, current: SceneNode[]): { history: History; nodes: SceneNode[] } | null {
  const nodes = h.past.at(-1);
  if (!nodes) return null;
  return { history: { past: h.past.slice(0, -1), future: [current, ...h.future] }, nodes };
}

export function redo(h: History, current: SceneNode[]): { history: History; nodes: SceneNode[] } | null {
  const nodes = h.future[0];
  if (!nodes) return null;
  return { history: { past: [...h.past, current].slice(-HISTORY_LIMIT), future: h.future.slice(1) }, nodes };
}

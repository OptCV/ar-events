import type { Content } from './actions.ts';

/**
 * Undo/redo for scene-editor edits (Phase 3 M10; actions since Phase 4 M12). It records the editor's content — nodes,
 * actions and the primary action — so references stay consistent; placement, tracking image and details are not part
 * of it, so undo never reverts those. Pure, so it is unit-tested; the editor keeps it in a ref.
 */
export interface History {
  past: Content[];
  future: Content[];
}

export const HISTORY_LIMIT = 100;
export const emptyHistory = (): History => ({ past: [], future: [] });

/** Record the content as it was before an edit. A new edit clears redo. No-op edits are not recorded. */
export function record(h: History, before: Content, after: Content): History {
  if (before === after || JSON.stringify(before) === JSON.stringify(after)) return h;
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), future: [] };
}

/** Step back: returns the content to restore, or null when there is nothing to undo. */
export function undo(h: History, current: Content): { history: History; content: Content } | null {
  const content = h.past.at(-1);
  if (!content) return null;
  return { history: { past: h.past.slice(0, -1), future: [current, ...h.future] }, content };
}

export function redo(h: History, current: Content): { history: History; content: Content } | null {
  const content = h.future[0];
  if (!content) return null;
  return { history: { past: [...h.past, current].slice(-HISTORY_LIMIT), future: h.future.slice(1) }, content };
}

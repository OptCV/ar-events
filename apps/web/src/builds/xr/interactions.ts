import type { XrAction, XrInteractions } from '@ar-creator/contracts';

/**
 * Interaction logic of the Android WebXR image viewer (Phase 5 M17, ADR-035), free of three.js and WebXR so it is
 * unit-tested. The scene GLB names every scene object's wrapper node by its scene id (ADR-032), which is how taps,
 * show/hide and animations find their objects.
 */
export type Effect = { kind: 'navigate'; href: string } | { kind: 'toggle'; nodeId: string } | { kind: 'play'; nodeId: string; clip: string } | null;

/** The tapped object: walking up from the hit mesh, the first scene node that has a tap action. */
export function tapTarget(chain: readonly string[], xr: Pick<XrInteractions, 'taps'>): { nodeId: string; actionId: string } | null {
  for (const name of chain) {
    const actionId = xr.taps[name];
    if (actionId) return { nodeId: name, actionId };
  }
  return null;
}

export function effectOf(actionId: string, xr: Pick<XrInteractions, 'actions'>): Effect {
  const a: XrAction | undefined = xr.actions.find((x) => x.id === actionId);
  if (!a) return null;
  if (a.type === 'link') return { kind: 'navigate', href: a.href };
  if (a.type === 'toggle-visibility') return { kind: 'toggle', nodeId: a.nodeId };
  return { kind: 'play', nodeId: a.nodeId, clip: a.clip };
}

/** On-screen buttons over the camera view: every link, the main button first (ADR-031). */
export function overlayButtons(xr: XrInteractions): { actionId: string; label: string; primary: boolean }[] {
  const links = xr.actions.filter((a) => a.type === 'link');
  const ordered = [...links.filter((a) => a.id === xr.primaryActionId), ...links.filter((a) => a.id !== xr.primaryActionId)];
  return ordered.map((a) => ({ actionId: a.id, label: a.label, primary: a.id === xr.primaryActionId }));
}

/**
 * The animation clip an action means: same name (unnamed clips are addressed "#index", as the editor lists them) and
 * animating something inside the target object's node subtree (the same model may be placed twice).
 */
export function findClip(clips: readonly { name: string; targets: readonly string[] }[], clip: string, subtree: ReadonlySet<string>): number | null {
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    const name = c.name.trim() || `#${i}`;
    if (name === clip && c.targets.some((t) => subtree.has(t))) return i;
  }
  // Clips merged from a model keep their names; when its targets cannot be told apart, the name alone decides.
  const byName = clips.findIndex((c, i) => (c.name.trim() || `#${i}`) === clip);
  return byName >= 0 ? byName : null;
}

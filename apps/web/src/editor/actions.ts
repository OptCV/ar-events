import { Action as ActionSchema, type Action, type DraftExperienceScene, type SceneNode } from '@ar-creator/schema';
import { nodeLabel, removeNode } from './sceneModel.ts';

/**
 * Actions in the editor (Phase 4 M12, ADR-030). The scene content the editor owns — nodes, actions and the primary
 * action — is edited as one unit so references always stay valid (the server refuses dangling ones).
 */
export type Content = Pick<DraftExperienceScene, 'nodes' | 'actions' | 'primaryActionId'>;
export type ActionType = Action['type'];

export const ACTION_TYPES: { type: ActionType; label: string }[] = [
  { type: 'open-url', label: 'Open a web page' },
  { type: 'mailto', label: 'Send an email' },
  { type: 'tel', label: 'Call a phone number' },
  { type: 'toggle-visibility', label: 'Show or hide an object' },
  { type: 'play-animation', label: 'Play a model animation' },
];
export const ACTION_TYPE_LABEL = Object.fromEntries(ACTION_TYPES.map((t) => [t.type, t.label])) as Record<ActionType, string>;

const target = (nodes: SceneNode[], id: string) => {
  const n = nodes.find((x) => x.id === id);
  return n ? `“${nodeLabel(n)}”` : 'a removed object';
};

/** One line a creator recognises: what happens when it runs. */
export function describeAction(a: Action, nodes: SceneNode[]): string {
  switch (a.type) {
    case 'open-url':
      return `Open ${a.url}`;
    case 'mailto':
      return `Email ${a.address}`;
    case 'tel':
      return `Call ${a.number}`;
    case 'toggle-visibility':
      return `Show or hide ${target(nodes, a.nodeId)}`;
    case 'play-animation':
      return `Play “${a.clip}” on ${target(nodes, a.nodeId)}`;
  }
}

/** The button text visitors see: the label, or a sensible default. */
export function actionTitle(a: Action, nodes: SceneNode[]): string {
  if ('label' in a && a.label?.trim()) return a.label.trim();
  if (a.type === 'open-url') return 'Visit website';
  if (a.type === 'mailto') return 'Send email';
  if (a.type === 'tel') return 'Call';
  return describeAction(a, nodes);
}

/** Option text for choosers: "Title — what it does", or just what it does when the title says the same. */
export function actionOption(a: Action, nodes: SceneNode[]): string {
  const title = actionTitle(a, nodes);
  const what = describeAction(a, nodes);
  return title === what ? what : `${title} — ${what}`;
}

/** Validates a candidate action with the scene schema; returns a readable message for the first problem. */
export function checkAction(candidate: unknown): { ok: true; action: Action } | { ok: false; field: string; message: string } {
  const r = ActionSchema.safeParse(candidate);
  if (r.success) return { ok: true, action: r.data };
  const issue = r.error.issues[0]!;
  const field = String(issue.path[0] ?? 'type');
  const friendly: Record<string, string> = {
    url: 'Enter a full web address starting with https://',
    address: 'Enter a valid email address.',
    number: 'Enter a phone number (digits, spaces, + ( ) -).',
    nodeId: 'Choose an object.',
    clip: 'Choose an animation.',
    label: 'Button text can be up to 60 characters.',
  };
  return { ok: false, field, message: friendly[field] ?? issue.message };
}

export interface Usage {
  /** Objects that run it when tapped (including hotspots). */
  nodes: SceneNode[];
  primary: boolean;
}

export function usageOf(c: Content, actionId: string): Usage {
  return { nodes: c.nodes.filter((n) => n.actionId === actionId), primary: c.primaryActionId === actionId };
}

/** The primary button can only be a web link (Quick Look banner and Scene Viewer `link` carry an https URL). */
export const canBePrimary = (a: Action) => a.type === 'open-url';

export function setPrimary(c: Content, actionId: string | null): Content {
  if (actionId === null) {
    const { primaryActionId: _drop, ...rest } = c;
    return rest;
  }
  const a = c.actions.find((x) => x.id === actionId);
  if (!a || !canBePrimary(a)) return c;
  return { ...c, primaryActionId: actionId };
}

/** Sets or clears an object's tap action. Hotspots always keep one (the schema requires it). */
export function setTapAction(c: Content, nodeId: string, actionId: string | null): Content {
  return {
    ...c,
    nodes: c.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      if (actionId === null) {
        if (n.kind === 'hotspot') return n;
        const { actionId: _drop, ...rest } = n;
        return rest as SceneNode;
      }
      return { ...n, actionId } as SceneNode;
    }),
  };
}

export function upsertAction(c: Content, a: Action): Content {
  const i = c.actions.findIndex((x) => x.id === a.id);
  const actions = i < 0 ? [...c.actions, a] : c.actions.map((x) => (x.id === a.id ? a : x));
  // A primary action edited into something that cannot be primary stops being primary (said in the UI).
  const next = { ...c, actions };
  return c.primaryActionId === a.id && !canBePrimary(a) ? setPrimary(next, null) : next;
}

export type RemoveActionResult = { ok: true; content: Content; cleared: string[] } | { ok: false; message: string };

/**
 * Deletes an action. Objects that ran it on tap stop doing so, and it stops being the primary button (both listed in
 * `cleared` for the notice). Hotspots exist only to run an action, so an action used by a hotspot cannot be deleted
 * until the hotspot gets another action or is removed.
 */
export function removeAction(c: Content, actionId: string): RemoveActionResult {
  const usage = usageOf(c, actionId);
  const hotspots = usage.nodes.filter((n) => n.kind === 'hotspot');
  if (hotspots.length) return { ok: false, message: `Used by ${hotspots.map((h) => `“${nodeLabel(h)}”`).join(', ')}. Give ${hotspots.length === 1 ? 'it' : 'them'} another action or remove ${hotspots.length === 1 ? 'it' : 'them'} first.` };
  let next: Content = { ...c, actions: c.actions.filter((a) => a.id !== actionId) };
  for (const n of usage.nodes) next = setTapAction(next, n.id, null);
  if (usage.primary) next = setPrimary(next, null);
  return { ok: true, content: next, cleared: [...usage.nodes.map((n) => `“${nodeLabel(n)}” no longer does anything when tapped`), ...(usage.primary ? ['the experience has no main button now'] : [])] };
}

/**
 * Removes an object (children move up, sceneModel.removeNode) and everything that would dangle: actions that show,
 * hide or animate it, with their tap uses and primary role; hotspots left without an action are removed too.
 * Returns what else was removed so the editor can say so — nothing disappears silently.
 */
export function removeNodeCascade(c: Content, nodeId: string): { content: Content; removed: string[] } {
  const gone = c.nodes.find((n) => n.id === nodeId);
  if (!gone) return { content: c, removed: [] };
  let next: Content = { ...c, nodes: removeNode(c.nodes, nodeId) };
  const removed: string[] = [];
  const dangling = next.actions.filter((a) => (a.type === 'toggle-visibility' || a.type === 'play-animation') && a.nodeId === nodeId);
  for (const a of dangling) {
    removed.push(`the action ${describeAction(a, c.nodes)}`);
    const hotspots = next.nodes.filter((n) => n.kind === 'hotspot' && n.actionId === a.id);
    for (const h of hotspots) {
      removed.push(`the hotspot “${nodeLabel(h)}”`);
      next = { ...next, nodes: removeNode(next.nodes, h.id) };
    }
    const r = removeAction(next, a.id);
    if (r.ok) next = r.content;
  }
  return { content: next, removed };
}

/** Animation clip names a model offers (from the loaded file); unnamed clips are addressed as "#index". */
export const clipName = (name: string, index: number) => name.trim() || `#${index}`;

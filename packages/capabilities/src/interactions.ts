/**
 * Interaction plan (Phase 4 Milestone 13, ADR-031): for one runtime, where the main button and every action of a scene
 * end up. Pure and shared by the editor (matrix, page preview), the API (readiness) and the P5 viewers/launchers.
 *
 * Guarantees (tested): every action is either reachable on a surface of each runtime, or reported as unavailable on
 * that runtime with a reason in `interactionIssues` — never silently dropped. Every link (web, email, phone) is always
 * on the experience page (PLATFORM_ROUTING.md: "Preserve all external links on landing page").
 */
import type { Runtime } from '@ar-creator/platform-launch';
import type { Action, DraftExperienceScene, PlacementMode, SceneNode } from '@ar-creator/schema';
import type { Feature, Support } from './index.ts';

type Scene = Pick<DraftExperienceScene, 'placement' | 'nodes' | 'actions' | 'primaryActionId'>;

/** The two runtimes a placement publishes to (PLATFORM_ROUTING.md). */
export const RUNTIMES_FOR: Record<PlacementMode, readonly [Runtime, Runtime]> = {
  image: ['ios_quicklook_image', 'android_webxr_image'],
  floor: ['ios_quicklook_floor', 'android_scene_viewer_floor'],
  wall: ['ios_quicklook_wall', 'android_scene_viewer_wall'],
};

export const RUNTIME_NAME: Record<Runtime, string> = {
  ios_quicklook_image: 'iPhone and iPad (Quick Look)',
  ios_quicklook_floor: 'iPhone and iPad (Quick Look)',
  ios_quicklook_wall: 'iPhone and iPad (Quick Look)',
  android_webxr_image: 'Android (image tracking, experimental)',
  android_scene_viewer_floor: 'Android (Scene Viewer)',
  android_scene_viewer_wall: 'Android (Scene Viewer)',
};

export type Surface = 'native-button' | 'overlay-button' | 'tap' | 'auto-play' | 'page';
export interface Route {
  surface: Surface;
  status: Support;
  note: string;
}
export interface ActionPlan {
  actionId: string;
  routes: Route[];
  /** Set when the action cannot run on this runtime at all (then `routes` is empty). */
  unavailable: string | null;
}
export interface PagePlanItem {
  actionId: string;
  label: string;
  kind: 'open-url' | 'mailto' | 'tel';
  primary: boolean;
}
export interface RuntimePlan {
  runtime: Runtime;
  /** The main button as this runtime shows it, plus the URL and label the launcher needs. */
  primary: { actionId: string; url: string; label: string; route: Route } | null;
  actions: ActionPlan[];
  /** Buttons on the public experience page, in order (main button first). Same on every runtime. */
  page: PagePlanItem[];
}

const isLink = (a: Action): a is Extract<Action, { type: 'open-url' | 'mailto' | 'tel' }> => a.type === 'open-url' || a.type === 'mailto' || a.type === 'tel';
const nativeViewer = (r: Runtime) => r !== 'android_webxr_image';
const viewerName = (r: Runtime) => (r.startsWith('ios_') ? 'Quick Look' : 'Scene Viewer');

export function buttonLabel(a: Action): string {
  if (isLink(a) && a.label?.trim()) return a.label.trim();
  return a.type === 'open-url' ? 'Visit website' : a.type === 'mailto' ? 'Send email' : a.type === 'tel' ? 'Call' : a.type === 'toggle-visibility' ? 'Show or hide' : 'Play animation';
}

const label = (n: SceneNode) => n.name?.trim() || (n.kind === 'hotspot' ? 'Hotspot' : 'an object');

export function pagePlan(scene: Scene): PagePlanItem[] {
  const links = scene.actions.filter(isLink);
  const ordered = [...links.filter((a) => a.id === scene.primaryActionId), ...links.filter((a) => a.id !== scene.primaryActionId)];
  return ordered.map((a) => ({ actionId: a.id, label: buttonLabel(a), kind: a.type, primary: a.id === scene.primaryActionId }));
}

export function planInteractions(scene: Scene, runtime: Runtime): RuntimePlan {
  const native = nativeViewer(runtime);
  const viewer = viewerName(runtime);
  const tappers = (id: string) => scene.nodes.filter((n) => n.actionId === id);
  const primaryAction = scene.actions.find((a) => a.id === scene.primaryActionId && a.type === 'open-url') as Extract<Action, { type: 'open-url' }> | undefined;

  const primaryRoute: Route | null = primaryAction
    ? runtime.startsWith('ios_')
      ? { surface: 'native-button', status: 'verify', note: 'Quick Look’s banner button; the experience page opens the link when it is tapped.' }
      : native
        ? { surface: 'native-button', status: 'verify', note: 'Scene Viewer’s own link button.' }
        : { surface: 'overlay-button', status: 'experimental', note: 'An on-screen button over the camera view (WebXR DOM overlay, where the browser supports it).' }
    : null;

  const actions: ActionPlan[] = scene.actions.map((a) => {
    const routes: Route[] = [];
    const taps = tappers(a.id);
    if (a.id === primaryAction?.id && primaryRoute) routes.push(primaryRoute);
    if (isLink(a)) {
      if (!native && a.id !== primaryAction?.id) routes.push({ surface: 'overlay-button', status: 'experimental', note: 'An on-screen button over the camera view, where the browser supports it.' });
      if (!native && taps.length) routes.push({ surface: 'tap', status: 'experimental', note: `Tapping ${taps.map((n) => `“${label(n)}”`).join(', ')}.` });
      routes.push({ surface: 'page', status: 'native', note: 'A button on the experience page.' });
      return { actionId: a.id, routes, unavailable: null };
    }
    // Behaviours run inside the AR view only.
    if (!native) {
      if (taps.length) routes.push({ surface: 'tap', status: 'experimental', note: `Tapping ${taps.map((n) => `“${label(n)}”`).join(', ')}.` });
      return { actionId: a.id, routes, unavailable: taps.length ? null : 'No object or hotspot runs it.' };
    }
    if (a.type === 'play-animation') {
      // Quick Look plays a model's animation on its own; Scene Viewer typically loops the first clip (capabilities).
      routes.push({ surface: 'auto-play', status: 'verify', note: `${viewer} cannot start it on request; ${runtime.startsWith('ios_') ? 'Quick Look plays the model’s animation by itself' : 'Scene Viewer usually loops the model’s first animation by itself'}.` });
      return { actionId: a.id, routes, unavailable: null };
    }
    return { actionId: a.id, routes, unavailable: `${viewer} cannot show or hide objects on request.` };
  });

  return {
    runtime,
    primary: primaryAction && primaryRoute ? { actionId: primaryAction.id, url: primaryAction.url, label: buttonLabel(primaryAction), route: primaryRoute } : null,
    actions,
    page: pagePlan(scene),
  };
}

export interface InteractionIssue {
  severity: 'warning';
  code: 'action_unavailable' | 'tap_not_supported' | 'action_unused' | 'animation_not_on_request';
  message: string;
  path: (string | number)[];
  runtimes: Runtime[];
}

const names = (rs: Runtime[]) => [...new Set(rs.map((r) => RUNTIME_NAME[r]))].join(' and ');

/**
 * Everything about the scene's interactions that will not work as the creator might expect, per placement. All are
 * warnings (publishing stays possible) and each names the action or object and the viewers concerned.
 */
export function interactionIssues(scene: Scene): InteractionIssue[] {
  const runtimes = RUNTIMES_FOR[scene.placement.mode];
  const plans = runtimes.map((r) => planInteractions(scene, r));
  const issues: InteractionIssue[] = [];
  scene.actions.forEach((a, i) => {
    const used = a.id === scene.primaryActionId || scene.nodes.some((n) => n.actionId === a.id);
    if (!isLink(a) && !used) {
      issues.push({ severity: 'warning', code: 'action_unused', message: `${describe(a, scene.nodes)} is not used by any object or hotspot, so it never runs.`, path: ['actions', i], runtimes: [...runtimes] });
      return;
    }
    const unavailable = plans.filter((p) => p.actions[i]!.unavailable);
    if (unavailable.length) {
      issues.push({
        severity: 'warning',
        code: 'action_unavailable',
        message: `${describe(a, scene.nodes)} does not work in ${names(unavailable.map((p) => p.runtime))}: ${unavailable[0]!.actions[i]!.unavailable}`,
        path: ['actions', i],
        runtimes: unavailable.map((p) => p.runtime),
      });
    }
    const auto = plans.filter((p) => p.actions[i]!.routes.some((r) => r.surface === 'auto-play'));
    if (auto.length) {
      issues.push({ severity: 'warning', code: 'animation_not_on_request', message: `${describe(a, scene.nodes)} cannot be started by a tap in ${names(auto.map((p) => p.runtime))}; the animation plays by itself there.`, path: ['actions', i], runtimes: auto.map((p) => p.runtime) });
    }
  });
  const nativeRuntimes = runtimes.filter(nativeViewer);
  scene.nodes.forEach((n, i) => {
    if (!n.actionId || !nativeRuntimes.length) return;
    const a = scene.actions.find((x) => x.id === n.actionId);
    if (!a) return;
    const where = isLink(a) ? 'its link is on the experience page instead.' : 'the action is not available there.';
    const what = n.kind === 'hotspot' ? `The hotspot “${label(n)}” is not shown` : `Tapping “${label(n)}” does nothing`;
    issues.push({ severity: 'warning', code: 'tap_not_supported', message: `${what} in ${names(nativeRuntimes)}; ${where}`, path: ['nodes', i], runtimes: nativeRuntimes });
  });
  return issues;
}

function describe(a: Action, nodes: SceneNode[]): string {
  const target = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n ? `“${label(n)}”` : 'a removed object';
  };
  switch (a.type) {
    case 'open-url':
      return `Open ${a.url}`;
    case 'mailto':
      return `Email ${a.address}`;
    case 'tel':
      return `Call ${a.number}`;
    case 'toggle-visibility':
      return `Show or hide ${target(a.nodeId)}`;
    case 'play-animation':
      return `Play “${a.clip}” on ${target(a.nodeId)}`;
  }
}

/** Features a scene uses, for the compatibility matrix (registry rows). `blendImageObjects`: image objects with Blend alpha. */
export function featuresUsed(scene: Scene, facts: { blendImageObjects?: number } = {}): Feature[] {
  const kinds = new Set(scene.nodes.map((n) => n.kind));
  const out: Feature[] = [];
  if (scene.placement.mode === 'image') out.push('image_target_recognition');
  if (kinds.has('model')) out.push('model');
  if (kinds.has('image-object')) out.push('image_object_flat');
  if ((facts.blendImageObjects ?? 0) > 0) out.push('semitransparency');
  if (kinds.has('text') || kinds.has('panel')) out.push('text_panel');
  if (kinds.has('primitive')) out.push('shape');
  if (kinds.has('hotspot')) out.push('hotspots');
  if (scene.actions.some((a) => a.type === 'play-animation')) out.push('model_animation');
  if (scene.primaryActionId) out.push('primary_cta');
  if (scene.actions.some((a) => isLink(a) && a.id !== scene.primaryActionId)) out.push('additional_links');
  return out;
}

/** What the native launchers need from the plan (Quick Look banner text, Scene Viewer `link`), P5 uses it. */
export function nativeLaunchOptions(plan: RuntimePlan): { callToAction?: string; link?: string } {
  if (!plan.primary) return {};
  if (plan.runtime.startsWith('ios_')) return { callToAction: plan.primary.label };
  if (plan.runtime.startsWith('android_scene_viewer')) return { link: plan.primary.url };
  return {};
}

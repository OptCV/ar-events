import { DraftExperienceScene, ExperienceScene, SCHEMA_VERSION, type DraftPlacement, type PlacementMode } from './scene.ts';

export const PLACEMENT_MODES = ['image', 'floor', 'wall'] as const satisfies readonly PlacementMode[];
/** Default printed width for a new image target (TESTING.md fixtures use 20 cm). */
export const DEFAULT_TRACKING_WIDTH_METERS = 0.2;

export function defaultPlacement(mode: PlacementMode): DraftPlacement {
  return mode === 'image' ? { mode, trackingTargetAssetId: null, physicalWidthMeters: DEFAULT_TRACKING_WIDTH_METERS } : { mode };
}

export function defaultDraftScene(mode: PlacementMode): DraftExperienceScene {
  return { schemaVersion: SCHEMA_VERSION, placement: defaultPlacement(mode), nodes: [], actions: [] };
}

/** Canonical anchor frame per mode (ADR-005): which axis is the surface normal. */
const NORMAL: Record<PlacementMode, '+Y' | '+Z'> = { image: '+Y', floor: '+Y', wall: '+Z' };

export interface PlacementChangePlan {
  from: PlacementMode;
  to: PlacementMode;
  changed: boolean;
  /** Must be shown to the creator and confirmed before saving (DESIGN.md: non-destructive migration review). */
  warnings: string[];
  /** Data removed from the placement (never nodes or actions). */
  removed: string[];
  placement: DraftPlacement;
}

/**
 * Switching placement keeps every node and action (never silently discards content). It only replaces the
 * placement block, and explains what that means. Node transforms are NOT rewritten automatically.
 */
export function planPlacementChange(scene: DraftExperienceScene, to: PlacementMode): PlacementChangePlan {
  const from = scene.placement.mode;
  if (from === to) return { from, to, changed: false, warnings: [], removed: [], placement: scene.placement };
  const warnings: string[] = [];
  const removed: string[] = [];
  if (scene.placement.mode === 'image') {
    if (scene.placement.trackingTargetAssetId) removed.push('tracking image');
    removed.push(`printed width (${Math.round(scene.placement.physicalWidthMeters * 1000) / 10} cm)`);
    warnings.push(
      scene.placement.trackingTargetAssetId
        ? 'The tracking image and its printed width will be removed from this experience. The uploaded image stays in your library.'
        : 'The printed-width setting for image placement will be removed.',
    );
  }
  if (to === 'image') warnings.push('Image mode needs a tracking image before you can publish.');
  if (to === 'wall' || from === 'wall') warnings.push('Wall placement anchors content to a vertical surface; floor and image placement use a horizontal one.');
  if (NORMAL[from] !== NORMAL[to] && scene.nodes.length > 0) {
    warnings.push(`${scene.nodes.length} object${scene.nodes.length === 1 ? '' : 's'} will keep their positions, which are now measured from the new surface. Check their orientation in the editor.`);
  }
  if (scene.nodes.length > 0 || scene.actions.length > 0) {
    warnings.push(`All ${scene.nodes.length} object(s) and ${scene.actions.length} action(s) are kept.`);
  }
  return { from, to, changed: true, warnings, removed, placement: defaultPlacement(to) };
}

export interface ReadinessIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path: (string | number)[];
}

/** What blocks publishing (errors) and what is advisable (warnings). Publishing itself arrives in Phase 1 M6. */
export function publishReadiness(scene: DraftExperienceScene): { ready: boolean; issues: ReadinessIssue[] } {
  const issues: ReadinessIssue[] = [];
  if (scene.placement.mode === 'image' && !scene.placement.trackingTargetAssetId) {
    issues.push({ severity: 'error', code: 'tracking_image_missing', message: 'Choose a tracking image for image placement.', path: ['placement', 'trackingTargetAssetId'] });
  }
  if (scene.nodes.length === 0) {
    issues.push({ severity: 'error', code: 'scene_empty', message: 'Add at least one object to the scene.', path: ['nodes'] });
  }
  const strict = ExperienceScene.safeParse(scene);
  if (!strict.success) {
    for (const i of strict.error.issues) {
      const path = i.path.map((p) => (typeof p === 'symbol' ? String(p) : p));
      if (path[0] === 'placement' && issues.some((x) => x.code === 'tracking_image_missing')) continue;
      issues.push({ severity: 'error', code: 'invalid_scene', message: i.message, path });
    }
  }
  if (!scene.primaryActionId) {
    issues.push({ severity: 'warning', code: 'no_primary_action', message: 'Consider adding a primary link (shown as the native button in AR).', path: ['primaryActionId'] });
  }
  return { ready: !issues.some((i) => i.severity === 'error'), issues };
}

import { z } from 'zod';
import { checkOutboundUrl } from './url.ts';

/**
 * Canonical scene schema (DATA_MODEL.md). Units: meters, quaternion [x, y, z, w], scale [x, y, z].
 *
 * Canonical anchor frame (ADR-005): right-handed, +Y up, meters (glTF convention).
 *  - floor: origin on the detected horizontal plane, +Y is the plane normal.
 *  - wall:  origin on the detected vertical plane, +Z is the wall normal (toward the viewer), +Y is world up.
 *  - image: origin at the tracking image center, +Y is the image normal, +X toward image right,
 *           +Z toward image bottom. (Assumed to match ARKit/ARCore image anchors — NOT device verified.)
 */
export const SCHEMA_VERSION = 1 as const;

const finite = z.number().finite();
export const Vec3 = z.tuple([finite, finite, finite]);
export const Quat = z
  .tuple([finite, finite, finite, finite])
  .refine((q) => Math.abs(Math.hypot(...q) - 1) < 1e-4, { message: 'rotation quaternion must be normalized' });
export const Transform = z.object({
  position: Vec3,
  rotation: Quat,
  scale: Vec3.refine((s) => s.every((v) => v > 0), { message: 'scale components must be > 0' }),
});
export type Transform = z.infer<typeof Transform>;

export const IDENTITY_TRANSFORM: Transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colours are #rrggbb');
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'ids must be 1-64 url-safe characters');

/** Physical tracking widths outside this range are almost certainly unit mistakes. */
export const TRACKING_WIDTH_METERS = { min: 0.03, max: 5 } as const;

export const Placement = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('image'),
    /** Role: tracking reference only. Never rendered as scene geometry by itself (ADR-003). */
    trackingTargetAssetId: Id,
    physicalWidthMeters: z.number().min(TRACKING_WIDTH_METERS.min).max(TRACKING_WIDTH_METERS.max),
  }),
  z.object({ mode: z.literal('floor') }),
  z.object({ mode: z.literal('wall') }),
]);
export type Placement = z.infer<typeof Placement>;
export type PlacementMode = Placement['mode'];

const NodeBase = {
  id: Id,
  parentId: Id.optional(),
  name: z.string().max(120).optional(),
  transform: Transform,
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  actionId: Id.optional(),
};

export const SceneNode = z.discriminatedUnion('kind', [
  z.object({ ...NodeBase, kind: z.literal('group') }),
  z.object({ ...NodeBase, kind: z.literal('model'), assetId: Id }),
  /** Display-image role: references a derivative pair (GLB + USDZ), never a tracking target. */
  z.object({ ...NodeBase, kind: z.literal('image-object'), derivativeId: Id }),
  z.object({
    ...NodeBase,
    kind: z.literal('text'),
    text: z.string().min(1).max(500),
    style: z.object({ color: HexColor, sizeMeters: z.number().positive().max(2) }),
  }),
  z.object({ ...NodeBase, kind: z.literal('panel'), title: z.string().max(120), body: z.string().max(2000) }),
  /** Geometry and defaults: content.ts (ADR-029). `color` is optional (added in M11; older scenes stay valid). */
  z.object({ ...NodeBase, kind: z.literal('primitive'), shape: z.enum(['box', 'sphere', 'cylinder', 'plane']), color: HexColor.optional() }),
  z.object({ ...NodeBase, kind: z.literal('hotspot'), actionId: Id }),
]);
export type SceneNode = z.infer<typeof SceneNode>;

const SafeUrl = z.string().superRefine((value, ctx) => {
  const r = checkOutboundUrl(value, ['https:']);
  if (!r.ok) ctx.addIssue({ code: 'custom', message: r.reason });
});

export const Action = z.discriminatedUnion('type', [
  z.object({ id: Id, type: z.literal('open-url'), url: SafeUrl, label: z.string().max(60).optional() }),
  z.object({ id: Id, type: z.literal('mailto'), address: z.email(), label: z.string().max(60).optional() }),
  z.object({
    id: Id,
    type: z.literal('tel'),
    number: z.string().regex(/^\+?[0-9 ()-]{3,32}$/),
    label: z.string().max(60).optional(),
  }),
  z.object({ id: Id, type: z.literal('play-animation'), nodeId: Id, clip: z.string().max(120) }),
  z.object({ id: Id, type: z.literal('toggle-visibility'), nodeId: Id }),
]);
export type Action = z.infer<typeof Action>;

/**
 * Draft placement (ADR-021): identical to `Placement` except that image mode may not have its tracking target yet
 * (uploaded later). Drafts may be incomplete; publishing requires the strict `ExperienceScene`.
 */
export const DraftPlacement = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('image'),
    trackingTargetAssetId: Id.nullable(),
    physicalWidthMeters: z.number().min(TRACKING_WIDTH_METERS.min).max(TRACKING_WIDTH_METERS.max),
  }),
  z.object({ mode: z.literal('floor') }),
  z.object({ mode: z.literal('wall') }),
]);
export type DraftPlacement = z.infer<typeof DraftPlacement>;

interface SceneShape {
  nodes: SceneNode[];
  actions: Action[];
  primaryActionId?: string | undefined;
}

/** Structural integrity shared by draft and publishable scenes: ids, references, cycles, primary action. */
function checkSceneIntegrity(scene: SceneShape, ctx: z.RefinementCtx) {
    const nodeIds = new Map<string, SceneNode>();
    scene.nodes.forEach((n, i) => {
      if (nodeIds.has(n.id)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: `duplicate node id ${n.id}` });
      nodeIds.set(n.id, n);
    });
    const actionIds = new Set<string>();
    scene.actions.forEach((a, i) => {
      if (actionIds.has(a.id)) ctx.addIssue({ code: 'custom', path: ['actions', i, 'id'], message: `duplicate action id ${a.id}` });
      actionIds.add(a.id);
      if ((a.type === 'play-animation' || a.type === 'toggle-visibility') && !nodeIds.has(a.nodeId)) {
        ctx.addIssue({ code: 'custom', path: ['actions', i, 'nodeId'], message: `unknown node ${a.nodeId}` });
      }
    });
    scene.nodes.forEach((n, i) => {
      if (n.parentId !== undefined && !nodeIds.has(n.parentId)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', i, 'parentId'], message: `unknown parent ${n.parentId}` });
      }
      if (n.actionId !== undefined && !actionIds.has(n.actionId)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', i, 'actionId'], message: `unknown action ${n.actionId}` });
      }
    });
    // Cycle detection over parent links.
    for (const start of scene.nodes) {
      const seen = new Set<string>();
      let cur: SceneNode | undefined = start;
      while (cur?.parentId !== undefined) {
        if (seen.has(cur.id)) {
          ctx.addIssue({ code: 'custom', path: ['nodes'], message: `parent cycle involving ${start.id}` });
          break;
        }
        seen.add(cur.id);
        cur = nodeIds.get(cur.parentId);
      }
    }
    if (scene.primaryActionId !== undefined) {
      const primary = scene.actions.find((a) => a.id === scene.primaryActionId);
      if (!primary) ctx.addIssue({ code: 'custom', path: ['primaryActionId'], message: 'unknown primary action' });
      else if (primary.type !== 'open-url') {
        // Quick Look banner and Scene Viewer `link` can only carry an https URL.
        ctx.addIssue({ code: 'custom', path: ['primaryActionId'], message: 'primary native action must be open-url' });
      }
    }
}

const sceneFields = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  nodes: z.array(SceneNode).max(500),
  actions: z.array(Action).max(100),
  primaryActionId: Id.optional(),
};

/** Publishable scene: strict placement + integrity. */
export const ExperienceScene = z.object({ ...sceneFields, placement: Placement }).superRefine(checkSceneIntegrity);
export type ExperienceScene = z.infer<typeof ExperienceScene>;

/** Draft scene stored by `PUT /api/experiences/:id/draft`: draft placement + the SAME integrity rules. */
export const DraftExperienceScene = z.object({ ...sceneFields, placement: DraftPlacement }).superRefine(checkSceneIntegrity);
export type DraftExperienceScene = z.infer<typeof DraftExperienceScene>;

/** Asset roles are explicit; never inferred from MIME type (DATA_MODEL.md). */
export const AssetRole = z.enum(['tracking-image', 'display-image', 'model', 'usdz-override', 'audio']);
export type AssetRole = z.infer<typeof AssetRole>;

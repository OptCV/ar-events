import { z } from 'zod';

/**
 * Test builds (Phase 5 Milestone 16, ADR-034): a draft compiled into the files the AR viewers open — one composed GLB
 * (Android) and one anchored USDZ (iPhone) — plus a short-lived public test link.
 */
export const SCENE_GLB_VERSION = 'scene-glb@0.1.0';
export const SCENE_USDZ_VERSION = 'scene-usdz@0.1.0';
/** Builds compiling at once per user. */
export const MAX_ACTIVE_BUILDS = 2;
/** How long a test link works. */
export const TEST_LINK_TTL_SECONDS = 24 * 60 * 60;
/** The Worker refuses to send more than this to the compiler (Worker memory; the container limit is 64 MB). */
export const MAX_BUILD_INPUT_BYTES = 48 * 1024 * 1024;

export const BUILD_ERRORS = [
  'files_unavailable', // a referenced image object, model or tracking image is gone or changed
  'empty_scene', // nothing visible to compile
  'too_large', // over Scene Viewer's 15 MB, or the inputs exceed MAX_BUILD_INPUT_BYTES
  'unsupported_model', // e.g. compressed meshes (iPhone)
  'bad_file', // a model file the compiler cannot read
  'tracking_image_missing', // image placement without a tracking image
  'validation_failed', // the output failed structural validation
  'converter_unavailable', // retried and still could not reach the compiler
  'output_mismatch', // the compiler answered with an unexpected version or damaged bytes
  'internal',
] as const;
export type BuildErrorCode = (typeof BUILD_ERRORS)[number];

export const BuildState = z.enum(['queued', 'compiling', 'ready', 'partially_ready', 'failed']);
export type BuildState = z.infer<typeof BuildState>;

export const BuildOutput = z.object({
  id: z.string(),
  platform: z.enum(['ios', 'android']),
  runtime: z.string(),
  format: z.enum(['glb', 'usdz']),
  state: z.enum(['pending', 'ready', 'failed']),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  warnings: z.array(z.string()),
  error: z.object({ code: z.enum(BUILD_ERRORS), message: z.string() }).nullable(),
});
export type BuildOutput = z.infer<typeof BuildOutput>;

export const BuildSummary = z.object({
  id: z.string(),
  experienceId: z.string(),
  revisionNumber: z.number().int(),
  state: BuildState,
  placementMode: z.enum(['image', 'floor', 'wall']),
  outputs: z.array(BuildOutput),
  error: z.object({ code: z.enum(BUILD_ERRORS), message: z.string() }).nullable(),
  /** Public test page (signed, works without signing in) once at least one output is ready. */
  testUrl: z.string().nullable(),
  testUrlExpiresAt: z.string().nullable(),
  /** True when the current draft is exactly what this build compiled. */
  current: z.boolean(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type BuildSummary = z.infer<typeof BuildSummary>;

/**
 * What the Android image viewer (WebXR, M17) runs, from the interaction plan (ADR-031): links as on-screen buttons and
 * taps; show/hide and animations from taps on objects or hotspots. Scene node ids match the GLB wrapper node names.
 */
export const XrAction = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('link'), label: z.string(), href: z.string() }),
  z.object({ id: z.string(), type: z.literal('toggle-visibility'), label: z.string(), nodeId: z.string() }),
  z.object({ id: z.string(), type: z.literal('play-animation'), label: z.string(), nodeId: z.string(), clip: z.string() }),
]);
export type XrAction = z.infer<typeof XrAction>;
export const XrInteractions = z.object({
  actions: z.array(XrAction),
  /** Tap targets: scene node id → action id (objects and hotspots). */
  taps: z.record(z.string(), z.string()),
  /** Hotspot node ids (the viewer draws a marker; the GLB has an empty node there). */
  hotspots: z.array(z.string()),
  /** The main button's action (shown first and highlighted among the on-screen buttons). */
  primaryActionId: z.string().nullable(),
});
export type XrInteractions = z.infer<typeof XrInteractions>;

/** What the public test page gets (no session; authorised by the signed test link). */
export const TestBuildResponse = z.object({
  id: z.string(),
  name: z.string(),
  placementMode: z.enum(['image', 'floor', 'wall']),
  /** Image placement: the printed width (meters) and the tracking image to print. */
  tracking: z.object({ widthMeters: z.number(), imageUrl: z.string() }).nullable(),
  glbUrl: z.string().nullable(),
  usdzUrl: z.string().nullable(),
  /** Why a platform's file is missing (failed output), for an honest message. */
  unavailable: z.object({ ios: z.string().nullable(), android: z.string().nullable() }),
  /** Main button (ADR-031): label + URL, when the scene has one. */
  primary: z.object({ label: z.string(), url: z.string() }).nullable(),
  /** Experience-page buttons, main button first. */
  links: z.array(z.object({ label: z.string(), href: z.string(), primary: z.boolean() })),
  /** Image placement: what the Android WebXR viewer runs. */
  xr: XrInteractions,
  /** File URLs expire sooner than the link; the page refetches. */
  filesExpireAt: z.string(),
  linkExpiresAt: z.string(),
});
export type TestBuildResponse = z.infer<typeof TestBuildResponse>;

/**
 * Central capability registry — code mirror of CAPABILITIES.md (ADR-007 vocabulary).
 * Every entry here is a PLANNING ASSUMPTION until `lastDeviceVerified` is filled from TESTING.md evidence.
 */
import type { Runtime } from '@ar-creator/platform-launch';
import { RUNTIMES } from '@ar-creator/platform-launch';

export type Support = 'native' | 'compiled_visual' | 'fallback_page' | 'experimental' | 'unsupported' | 'verify';
export type Fallback = 'landing_page' | 'static_geometry' | 'disabled';

export const FEATURES = [
  'model',
  'image_target_recognition',
  'image_object_flat',
  'semitransparency',
  'text_panel',
  'shape',
  'primary_cta',
  'additional_links',
  'hotspots',
  'html_overlay',
  'model_animation',
  'video',
  'creator_js',
] as const;
export type Feature = (typeof FEATURES)[number];

export interface CapabilityEntry {
  status: Support;
  fallback?: Fallback;
  /** User-facing explanation shown in the editor/compat report. */
  message: string;
  lastDeviceVerified?: { device: string; os: string; viewer: string; date: string };
}

type Row = Record<'ios' | 'android_image' | 'android_sv', CapabilityEntry>;
const IOS_RUNTIMES: Runtime[] = ['ios_quicklook_image', 'ios_quicklook_floor', 'ios_quicklook_wall'];
const SV_RUNTIMES: Runtime[] = ['android_scene_viewer_floor', 'android_scene_viewer_wall'];

const LANDING = 'Shown on the experience page; the native viewer cannot display it.';

const TABLE: Record<Feature, Row> = {
  model: {
    ios: { status: 'verify', message: 'Converted to USDZ; fidelity must be checked in Quick Look.' },
    android_image: { status: 'verify', message: 'Rendered with Three.js from GLB.' },
    android_sv: { status: 'verify', message: 'Composed into the single Scene Viewer GLB.' },
  },
  image_target_recognition: {
    ios: { status: 'verify', message: 'Quick Look image anchoring (Apple preliminary schema).' },
    android_image: { status: 'experimental', message: 'Image tracking requires a supported Android Chrome configuration. You can still preview this experience in 3D.' },
    android_sv: { status: 'unsupported', fallback: 'disabled', message: 'Scene Viewer cannot track images; image mode uses WebXR on Android.' },
  },
  image_object_flat: {
    ios: { status: 'verify', message: 'USD textured quad with alpha → opacity.' },
    android_image: { status: 'verify', message: 'GLB textured quad with alpha.' },
    android_sv: { status: 'verify', message: 'GLB textured quad with alpha.' },
  },
  semitransparency: {
    ios: { status: 'verify', message: 'Transparent pixels will remain see-through in the AR object. Some materials may render differently between devices.' },
    android_image: { status: 'verify', message: 'glTF BLEND; verify on device.' },
    android_sv: { status: 'verify', message: 'glTF BLEND; verify on device.' },
  },
  text_panel: {
    ios: { status: 'compiled_visual', fallback: 'static_geometry', message: 'Baked into textured geometry (not interactive).' },
    android_image: { status: 'native', message: 'Rendered live in Three.js.' },
    android_sv: { status: 'compiled_visual', fallback: 'static_geometry', message: 'Baked into the composed GLB (not interactive).' },
  },
  shape: {
    ios: { status: 'verify', message: 'Exported as USD geometry with a plain colour.' },
    android_image: { status: 'native', message: 'Rendered live in Three.js.' },
    android_sv: { status: 'verify', message: 'Composed into the single Scene Viewer GLB.' },
  },
  primary_cta: {
    ios: { status: 'verify', message: 'Quick Look banner action; the page handles the tap.' },
    android_image: { status: 'native', message: 'WebXR DOM overlay button where supported.' },
    android_sv: { status: 'verify', message: 'Scene Viewer `link` parameter.' },
  },
  additional_links: {
    ios: { status: 'fallback_page', fallback: 'landing_page', message: LANDING },
    android_image: { status: 'experimental', fallback: 'landing_page', message: 'DOM overlay where supported, otherwise the experience page.' },
    android_sv: { status: 'fallback_page', fallback: 'landing_page', message: LANDING },
  },
  hotspots: {
    ios: { status: 'fallback_page', fallback: 'landing_page', message: 'This hotspot is interactive in Android image-tracking mode. On iOS and Android Scene Viewer, its link appears on the experience page.' },
    android_image: { status: 'experimental', message: 'Three.js raycast action (feature-tested).' },
    android_sv: { status: 'fallback_page', fallback: 'landing_page', message: 'This hotspot is interactive in Android image-tracking mode. On iOS and Android Scene Viewer, its link appears on the experience page.' },
  },
  html_overlay: {
    ios: { status: 'unsupported', fallback: 'landing_page', message: 'Quick Look cannot show custom HTML in AR.' },
    android_image: { status: 'experimental', message: 'WebXR DOM overlay if the browser supports it.' },
    android_sv: { status: 'unsupported', fallback: 'landing_page', message: 'Scene Viewer cannot show custom HTML in AR.' },
  },
  model_animation: {
    ios: { status: 'verify', message: 'USD animation; subset depends on conversion.' },
    android_image: { status: 'verify', message: 'Three.js animation clips.' },
    android_sv: { status: 'verify', message: 'Scene Viewer plays a limited subset (typically the first clip).' },
  },
  video: {
    ios: { status: 'unsupported', fallback: 'landing_page', message: 'Future capability; shown on the experience page.' },
    android_image: { status: 'unsupported', fallback: 'landing_page', message: 'Future capability; shown on the experience page.' },
    android_sv: { status: 'unsupported', fallback: 'landing_page', message: 'Future capability; shown on the experience page.' },
  },
  creator_js: {
    ios: { status: 'unsupported', fallback: 'disabled', message: 'Custom scripts are never executed.' },
    android_image: { status: 'unsupported', fallback: 'disabled', message: 'Custom scripts are never executed.' },
    android_sv: { status: 'unsupported', fallback: 'disabled', message: 'Custom scripts are never executed.' },
  },
};

function column(runtime: Runtime): keyof Row {
  if (IOS_RUNTIMES.includes(runtime)) return 'ios';
  if (SV_RUNTIMES.includes(runtime)) return 'android_sv';
  return 'android_image';
}

export function capability(feature: Feature, runtime: Runtime): CapabilityEntry {
  // Image recognition is only meaningful for image runtimes.
  if (feature === 'image_target_recognition' && !runtime.endsWith('_image')) {
    return { status: 'unsupported', fallback: 'disabled', message: 'Not used in floor/wall placement.' };
  }
  return TABLE[feature][column(runtime)];
}

export interface CompatIssue {
  feature: Feature;
  runtime: Runtime;
  entry: CapabilityEntry;
}

/** Pre-publish report: everything not `native` for the given runtimes. Nothing is silently dropped. */
export function compatibilityReport(features: readonly Feature[], runtimes: readonly Runtime[] = RUNTIMES): CompatIssue[] {
  const out: CompatIssue[] = [];
  for (const feature of features)
    for (const runtime of runtimes) {
      const entry = capability(feature, runtime);
      if (entry.status !== 'native') out.push({ feature, runtime, entry });
    }
  return out;
}

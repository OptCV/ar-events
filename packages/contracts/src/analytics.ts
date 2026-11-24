import { z } from 'zod';

/**
 * Anonymous aggregate analytics (Phase 6 M19, ADR-037). Only daily counts per published experience; nothing about
 * individual visitors is sent or stored. `ar_tap` counts taps on the AR button: an observable intent, not proof that
 * AR started (PLATFORM_ROUTING.md).
 */
export const AR_TAP_RUNTIMES = [
  'ios_quicklook_image',
  'ios_quicklook_floor',
  'ios_quicklook_wall',
  'android_webxr_image',
  'android_scene_viewer_floor',
  'android_scene_viewer_wall',
] as const;

export const AnalyticsEventInput = z.discriminatedUnion('event', [
  z.object({ event: z.literal('view'), detail: z.enum(['ios', 'android', 'desktop']) }),
  z.object({ event: z.literal('ar_tap'), detail: z.enum(AR_TAP_RUNTIMES) }),
  z.object({ event: z.literal('link_tap'), detail: z.enum(['web', 'email', 'phone']) }),
]);
export type AnalyticsEventInput = z.infer<typeof AnalyticsEventInput>;

export const ANALYTICS_MAX_DAYS = 90;

export const AnalyticsSummary = z.object({
  days: z.number().int(),
  /** First day counted (UTC, inclusive). */
  since: z.string(),
  totals: z.object({ views: z.number().int(), arTaps: z.number().int(), linkTaps: z.number().int() }),
  /** Views by device kind; AR taps by viewer: ios = Quick Look, android = Scene Viewer or image tracking. */
  views: z.object({ ios: z.number().int(), android: z.number().int(), desktop: z.number().int() }),
  arTaps: z.object({ quickLook: z.number().int(), sceneViewer: z.number().int(), webxr: z.number().int() }),
  perDay: z.array(z.object({ day: z.string(), views: z.number().int(), arTaps: z.number().int(), linkTaps: z.number().int() })),
});
export type AnalyticsSummary = z.infer<typeof AnalyticsSummary>;

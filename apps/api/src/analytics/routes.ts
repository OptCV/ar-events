/**
 * Anonymous aggregate analytics (Phase 6 M19, ADR-037).
 *
 *   POST /api/public/:slug/events      PUBLIC: count one event for a published experience (no cookies, nothing stored
 *                                      about the visitor: only +1 on a daily counter)
 *   GET  /api/experiences/:id/analytics?days=30   owner: totals and per-day counts
 */
import { Hono, type Context } from 'hono';
import { and, eq, gte, sql } from 'drizzle-orm';
import { ANALYTICS_MAX_DAYS, AnalyticsEventInput, type AnalyticsSummary } from '@ar-creator/contracts';
import { schema } from '@ar-creator/db';
import type { AppEnv } from '../app.ts';
import { requireSession } from '../auth/middleware.ts';
import { err, parseJson } from '../http.ts';

const { analyticsDaily, experienceRevisions, experiences } = schema;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

export function analyticsRoutes() {
  const r = new Hono<AppEnv>();

  r.post('/public/:slug/events', async (c) => {
    const slug = c.req.param('slug');
    if (!/^[a-z0-9-]{3,64}$/.test(slug)) return c.body(null, 204); // never reveal anything to a counter
    const parsed = await parseJson(c, AnalyticsEventInput);
    if (!parsed.ok) return parsed.res;
    const { db } = await c.get('db')();
    const [e] = await db
      .select({ id: experiences.id })
      .from(experiences)
      .innerJoin(experienceRevisions, eq(experienceRevisions.id, experiences.publishedRevisionId))
      .where(and(eq(experiences.slug, slug), eq(experiences.visibility, 'public'), eq(experienceRevisions.state, 'published')))
      .limit(1);
    // Unpublished or unknown: accepted and ignored (the same answer, so a counter cannot probe slugs).
    if (e) {
      await db
        .insert(analyticsDaily)
        .values({ experienceId: e.id, day: today(), event: parsed.data.event, detail: parsed.data.detail, count: 1 })
        .onConflictDoUpdate({ target: [analyticsDaily.experienceId, analyticsDaily.day, analyticsDaily.event, analyticsDaily.detail], set: { count: sql`${analyticsDaily.count} + 1` } });
    }
    return c.body(null, 204);
  });

  r.get('/experiences/:id/analytics', requireSession, async (c: Context<AppEnv>) => {
    const id = c.req.param('id')!;
    if (!UUID.test(id)) return err(c, 404, 'not_found', 'Not found.');
    const days = Math.min(ANALYTICS_MAX_DAYS, Math.max(1, Number.parseInt(c.req.query('days') ?? '30', 10) || 30));
    const { db } = await c.get('db')();
    const [e] = await db.select({ id: experiences.id }).from(experiences).where(and(eq(experiences.id, id), eq(experiences.ownerId, c.get('user').id))).limit(1);
    if (!e) return err(c, 404, 'not_found', 'Not found.');
    const sinceDate = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = await db.select().from(analyticsDaily).where(and(eq(analyticsDaily.experienceId, id), gte(analyticsDaily.day, sinceDate)));
    const out: AnalyticsSummary = {
      days,
      since: sinceDate,
      totals: { views: 0, arTaps: 0, linkTaps: 0 },
      views: { ios: 0, android: 0, desktop: 0 },
      arTaps: { quickLook: 0, sceneViewer: 0, webxr: 0 },
      perDay: [],
    };
    const perDay = new Map<string, { views: number; arTaps: number; linkTaps: number }>();
    for (const r0 of rows) {
      const d = perDay.get(r0.day) ?? { views: 0, arTaps: 0, linkTaps: 0 };
      if (r0.event === 'view') {
        out.totals.views += r0.count;
        d.views += r0.count;
        if (r0.detail === 'ios' || r0.detail === 'android' || r0.detail === 'desktop') out.views[r0.detail] += r0.count;
      } else if (r0.event === 'ar_tap') {
        out.totals.arTaps += r0.count;
        d.arTaps += r0.count;
        if (r0.detail.startsWith('ios_')) out.arTaps.quickLook += r0.count;
        else if (r0.detail === 'android_webxr_image') out.arTaps.webxr += r0.count;
        else out.arTaps.sceneViewer += r0.count;
      } else {
        out.totals.linkTaps += r0.count;
        d.linkTaps += r0.count;
      }
      perDay.set(r0.day, d);
    }
    out.perDay = [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v }));
    c.header('Cache-Control', 'no-store');
    return c.json(out);
  });

  return r;
}

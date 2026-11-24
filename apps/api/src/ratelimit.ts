/**
 * Rate limits for the public (session-less) endpoints (Phase 6 M20, ADR-038).
 *
 * Fixed one-minute windows per client IP and bucket, stored in the same `rate_limit` table Better Auth uses for
 * sign-in limits (keys are prefixed `app:` so they never collide with Better Auth's). The IP is Cloudflare's
 * `CF-Connecting-IP`, which the edge always sets and a client cannot supply (REMOTE-CF-IP). Without it (local
 * development outside Cloudflare) there is no trustworthy client identity and requests are not limited.
 */
import type { MiddlewareHandler } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppEnv } from './app.ts';
import { err } from './http.ts';
import { logError } from './db.ts';

export const PUBLIC_RATE_LIMITS = {
  /** Public page and test-link reads (each visit makes one, plus a refetch every ~15 minutes). */
  'public-read': { window: 60, max: 60 },
  /** Anonymous analytics events (a visit sends 1–3). */
  'public-event': { window: 60, max: 30 },
  /** `/api/health` opens a database connection per call; monitors poll it about once a minute. */
  health: { window: 60, max: 30 },
} as const;
export type RateBucket = keyof typeof PUBLIC_RATE_LIMITS;

/** Share of requests that also delete expired `app:` rows, so one-off visitors do not accumulate. */
const CLEANUP_PROBABILITY = 0.01;

export function rateLimit(bucket: RateBucket): MiddlewareHandler<AppEnv> {
  const { window, max } = PUBLIC_RATE_LIMITS[bucket];
  return async (c, next) => {
    const ip = c.req.header('cf-connecting-ip');
    if (!ip) return next();
    const key = `app:${bucket}:${ip}`;
    const now = Date.now();
    const windowStart = now - window * 1000;
    let row: { count: number; last_request: string | number };
    try {
      const { db } = await c.get('db')();
      const rows = await db.execute<{ count: number; last_request: string | number }>(sql`
        INSERT INTO rate_limit (id, key, count, last_request) VALUES (${key}, ${key}, 1, ${now})
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN rate_limit.last_request < ${windowStart} THEN 1 ELSE rate_limit.count + 1 END,
          last_request = CASE WHEN rate_limit.last_request < ${windowStart} THEN ${now} ELSE rate_limit.last_request END
        RETURNING count, last_request`);
      row = rows.rows[0]!;
      if (Math.random() < CLEANUP_PROBABILITY) {
        await db.execute(sql`DELETE FROM rate_limit WHERE key LIKE 'app:%' AND last_request < ${now - 3600_000}`);
      }
    } catch (e) {
      // Fail open: the handler then reports the outage (health) or fails on its own database access.
      logError(c, 'ratelimit.unavailable', e instanceof Error ? e.message : String(e));
      return next();
    }
    if (row.count > max) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((Number(row.last_request) + window * 1000 - now) / 1000))));
      return err(c, 429, 'too_many_requests', 'Too many requests. Try again in a minute.');
    }
    return next();
  };
}

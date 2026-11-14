import { z } from 'zod';

/**
 * Database check. Only coarse, non-sensitive categories are exposed: never hostnames, connection strings,
 * driver messages or SQL. Details go to redacted server logs.
 */
export const DatabaseCheck = z.object({
  status: z.enum(['ok', 'error']),
  latencyMs: z.number().int().nonnegative().optional(),
  /** `behind` = bundled migrations not yet applied to this database (production migrations need owner approval). */
  migrations: z.enum(['current', 'behind', 'ahead', 'unknown']).optional(),
  error: z.enum(['not_configured', 'timeout', 'unreachable', 'auth', 'misconfigured', 'query_failed', 'unknown']).optional(),
});
export type DatabaseCheck = z.infer<typeof DatabaseCheck>;

/** GET /api/health — 200 when every check passes, 503 with status `degraded` otherwise. */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('ar-creator'),
  /** Semantic app version from package.json at build time. */
  version: z.string().min(1),
  /** Git commit the bundle was built from, or "dev". */
  build: z.string().min(1),
  /** `workerd` when served by the Workers runtime (dev, preview and production all use workerd). */
  runtime: z.enum(['workerd', 'other']),
  time: z.iso.datetime(),
  checks: z.object({ database: DatabaseCheck }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

import { z } from 'zod';

/** GET /api/health — liveness only. Milestone 2 adds dependency checks (database) under `checks`. */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.literal('ar-creator'),
  /** Semantic app version from package.json at build time. */
  version: z.string().min(1),
  /** Git commit the bundle was built from, or "dev". */
  build: z.string().min(1),
  /** `workerd` when served by the Workers runtime (dev, preview and production all use workerd). */
  runtime: z.enum(['workerd', 'other']),
  time: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

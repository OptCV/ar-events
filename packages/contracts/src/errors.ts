import { z } from 'zod';

/** Every API error uses this shape. `requestId` correlates with Worker logs; no stack traces or internals. */
export const ApiError = z.object({
  error: z.object({
    code: z.enum(['not_found', 'method_not_allowed', 'bad_request', 'unauthorized', 'forbidden', 'conflict', 'payload_too_large', 'unavailable', 'internal']),
    message: z.string(),
    requestId: z.string().optional(),
    /** Field-level validation problems (bad_request). Paths follow the request body. */
    issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
    /** For `conflict`: machine-readable reason and the server's current draft version. */
    reason: z.enum(['stale_draft', 'placement_change_unconfirmed', 'slug_taken']).optional(),
    currentDraftVersion: z.number().int().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
export type ApiErrorCode = ApiError['error']['code'];

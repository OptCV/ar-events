import { z } from 'zod';
import { FILE_REJECTIONS } from './assets.ts';

/** Machine-readable reasons for `conflict` (409) responses. */
export const CONFLICT_REASONS = ['stale_draft', 'placement_change_unconfirmed', 'slug_taken', 'upload_not_pending', 'quota_exceeded', 'asset_in_use', 'conversion_running', 'not_convertible', 'not_ready', 'build_running'] as const;

/** Every API error uses this shape. `requestId` correlates with Worker logs; no stack traces or internals. */
export const ApiError = z.object({
  error: z.object({
    code: z.enum(['not_found', 'method_not_allowed', 'bad_request', 'unauthorized', 'forbidden', 'conflict', 'payload_too_large', 'invalid_file', 'too_many_requests', 'unavailable', 'internal']),
    message: z.string(),
    requestId: z.string().optional(),
    /** Field-level validation problems (bad_request). Paths follow the request body. */
    issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
    /** For `conflict` and `invalid_file`: machine-readable reason; for draft conflicts, the server's current draft version. */
    reason: z.enum([...CONFLICT_REASONS, ...FILE_REJECTIONS]).optional(),
    currentDraftVersion: z.number().int().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
export type ApiErrorCode = ApiError['error']['code'];

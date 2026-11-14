import { z } from 'zod';

/** Every API error uses this shape. `requestId` correlates with Worker logs; no stack traces or internals. */
export const ApiError = z.object({
  error: z.object({
    code: z.enum(['not_found', 'method_not_allowed', 'bad_request', 'unauthorized', 'forbidden', 'unavailable', 'internal']),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
export type ApiErrorCode = ApiError['error']['code'];

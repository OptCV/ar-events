import type { z } from 'zod';
import { ApiError } from '@ar-creator/contracts';

/** Error thrown for non-2xx responses or contract violations; message is safe to show to users. */
export class ApiRequestError extends Error {
  override name = 'ApiRequestError';
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * Same-origin JSON fetch validated against a shared contract (packages/contracts).
 * Credentials are same-origin only (ADR-014); never call cross-origin APIs with cookies.
 */
export async function getJson<S extends z.ZodType>(path: `/api/${string}`, schema: S, init?: RequestInit): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' }, ...init });
  } catch {
    throw new ApiRequestError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ApiError.safeParse(data);
    if (parsed.success) throw new ApiRequestError(res.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.requestId);
    throw new ApiRequestError(res.status, 'http', `Request failed (${res.status}).`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiRequestError(res.status, 'contract', 'The server sent an unexpected response.');
  return parsed.data;
}

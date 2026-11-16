import type { z } from 'zod';
import { ApiError } from '@ar-creator/contracts';

type ApiErrorBody = ApiError['error'];

/** Error thrown for non-2xx responses or contract violations; message is safe to show to users. */
export class ApiRequestError extends Error {
  override name = 'ApiRequestError';
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly issues: NonNullable<ApiErrorBody['issues']>;
  readonly reason: ApiErrorBody['reason'];
  readonly currentDraftVersion: number | undefined;
  constructor(status: number, code: string, message: string, extra: Partial<Pick<ApiErrorBody, 'requestId' | 'issues' | 'reason' | 'currentDraftVersion'>> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = extra.requestId;
    this.issues = extra.issues ?? [];
    this.reason = extra.reason;
    this.currentDraftVersion = extra.currentDraftVersion;
  }
}

async function handle<S extends z.ZodType>(res: Response, schema: S | null, acceptStatuses: readonly number[]): Promise<z.infer<S>> {
  if (res.status === 204) return undefined as z.infer<S>;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok && !acceptStatuses.includes(res.status)) {
    const parsed = ApiError.safeParse(data);
    if (parsed.success) {
      const e = parsed.data.error;
      throw new ApiRequestError(res.status, e.code, e.message, e);
    }
    throw new ApiRequestError(res.status, 'http', `Request failed (${res.status}).`);
  }
  if (!schema) return data as z.infer<S>;
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiRequestError(res.status, 'contract', 'The server sent an unexpected response.');
  return parsed.data;
}

const NETWORK = () => new ApiRequestError(0, 'network', 'Cannot reach the server. Check your connection and try again.');

/**
 * Same-origin JSON fetch validated against a shared contract (packages/contracts).
 * Credentials are same-origin only (ADR-014); never call cross-origin APIs with cookies.
 */
export async function getJson<S extends z.ZodType>(
  path: `/api/${string}`,
  schema: S,
  init?: RequestInit,
  /** Non-2xx statuses whose body still follows `schema` (e.g. 503 from /api/health when degraded). */
  acceptStatuses: readonly number[] = [],
): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' }, ...init });
  } catch {
    throw NETWORK();
  }
  return handle(res, schema, acceptStatuses);
}

/** JSON mutation (POST/PUT/PATCH/DELETE). The browser adds Origin; the API requires it (CSRF guard). */
export async function sendJson<S extends z.ZodType>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: `/api/${string}`, body: unknown, schema: S | null): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw NETWORK();
  }
  return handle(res, schema, []);
}

/** Map API field issues (path → message) for forms; only the first message per top-level field. */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiRequestError)) return {};
  const out: Record<string, string> = {};
  for (const i of e.issues) {
    const key = String(i.path[0] ?? '');
    if (key && !out[key]) out[key] = i.message;
  }
  return out;
}

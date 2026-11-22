import type { Context } from 'hono';
import type { z } from 'zod';
import type { ApiError } from '@ar-creator/contracts';
import type { AppEnv } from './app.ts';

type ErrorExtras = Pick<ApiError['error'], 'issues' | 'reason' | 'currentDraftVersion'>;
export type ErrorStatus = 400 | 403 | 404 | 409 | 411 | 413 | 422 | 429 | 503;

/** JSON error response in the shared contract shape (no internals). */
export function err(c: Context<AppEnv>, status: ErrorStatus, code: ApiError['error']['code'], message: string, extras: ErrorExtras = {}) {
  const body: ApiError = { error: { code, message, requestId: c.get('requestId'), ...extras } };
  return c.json(body, status);
}

/** Parse a JSON body against a contract; 400 with field issues on failure. */
export async function parseJson<S extends z.ZodType>(c: Context<AppEnv>, s: S): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  const json: unknown = await c.req.json().catch(() => undefined);
  if (json === undefined) return { ok: false, res: err(c, 400, 'bad_request', 'Send a JSON body.') };
  const r = s.safeParse(json);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 50).map((i) => ({ path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)), message: i.message }));
    return { ok: false, res: err(c, 400, 'bad_request', 'Some fields are invalid.', { issues }) };
  }
  return { ok: true, data: r.data };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

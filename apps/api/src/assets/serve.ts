/**
 * Streams a stored object for the signed-read endpoints, with single-range support (Phase 7 M21, ADR-039): native
 * viewers and media stacks may ask for byte ranges of large GLB/USDZ files. `Range: bytes=a-b | a- | -n` → 206 with
 * `Content-Range`; unsatisfiable → 416; multiple or malformed ranges, or a stale `If-Range` → the whole file (200).
 */
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import type { ObjectStore } from './store.ts';

export type ByteRange = { offset: number; length: number };

/** null = serve the whole file; 'unsatisfiable' = 416. */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // RFC 9110: a server may ignore ranges it does not support
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

/** null when the object is missing (the caller logs it and answers 404). */
export async function serveObject(c: Context<AppEnv>, store: ObjectStore, key: string, etag: string, headers: Record<string, string>): Promise<Response | null> {
  const base = { ...headers, etag, 'accept-ranges': 'bytes' };
  const rangeHeader = c.req.header('range');
  const ifRange = c.req.header('if-range');
  if (rangeHeader && (!ifRange || ifRange === etag)) {
    const head = await store.head(key);
    if (!head) return null;
    const range = parseRange(rangeHeader, head.size);
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${head.size}` } });
    if (range) {
      const obj = await store.get(key, range);
      if (!obj) return null;
      return new Response(obj.body, {
        status: 206,
        headers: { ...base, 'content-length': String(range.length), 'content-range': `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}` },
      });
    }
  }
  const obj = await store.get(key);
  if (!obj) return null;
  return new Response(obj.body, { headers: { ...base, 'content-length': String(obj.size) } });
}

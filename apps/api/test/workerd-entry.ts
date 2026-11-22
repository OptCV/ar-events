/**
 * Test-only Worker for assets.workerd.test.ts: runs the REAL R2 adapter + upload pipeline inside workerd
 * (Miniflare's R2 simulator), streaming the incoming request body exactly like PUT /api/assets/:id/content.
 */
import { UploadableRole } from '@ar-creator/contracts';
import { UploadRejected, createHasher, createUploadPipeline } from '../src/assets/pipeline.ts';
import { r2Store } from '../src/assets/store.ts';

interface TestEnv {
  BUCKET: R2Bucket;
}

export default {
  async fetch(req: Request, env: TestEnv): Promise<Response> {
    const url = new URL(req.url);
    const key = url.searchParams.get('key') ?? 'k';
    const store = r2Store(env.BUCKET);
    if (url.pathname === '/head') {
      const o = await env.BUCKET.get(key);
      if (!o) return Response.json(null);
      const bytes = new Uint8Array(await o.arrayBuffer());
      const h = createHasher();
      h.update(bytes);
      return Response.json({ size: o.size, contentType: o.httpMetadata?.contentType ?? null, sha256: await h.digestHex(), nativeDigest: typeof (crypto as unknown as { DigestStream?: unknown }).DigestStream === 'function' });
    }
    const size = Number(url.searchParams.get('size') ?? req.headers.get('content-length'));
    const expected = url.searchParams.get('sha') ?? undefined;
    const p = createUploadPipeline({ role: UploadableRole.parse(url.searchParams.get('role')), declaredType: url.searchParams.get('type')!, size, expectedSha256: expected });
    try {
      await store.put(key, req.body!.pipeThrough(p.transform), { size, contentType: url.searchParams.get('type')!, ...(url.searchParams.get('r2sha') ? { sha256Hex: url.searchParams.get('r2sha')! } : {}) });
      return Response.json({ ok: true, sha256: p.outcome().sha256 });
    } catch (e) {
      return Response.json({ ok: false, rejected: e instanceof UploadRejected ? e.code : null, error: e instanceof Error ? e.message : String(e) });
    }
  },
};

/**
 * R2 adapter in workerd (ADR-022): proves the platform behaviour the API relies on, with Miniflare's local R2:
 *   - a streamed put with FixedLengthStream stores exactly the bytes, hashed natively (crypto.DigestStream);
 *   - when the pipeline errors (bad head, truncated tail, checksum mismatch) NOTHING is stored;
 *   - a failed write never damages an existing object at the same key.
 * This is a local simulator, not production R2; the deployed check is pending (TESTING.md).
 */
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeGlb, sha256Hex, trackingPng } from './files.ts';

let mf: Miniflare;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('./workerd-entry.ts', import.meta.url).href)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    write: false,
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'import'],
  });
  // Miniflare 5 takes a new option shape; its converter accepts the documented (v4) flat options.
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: [{ type: 'ESModule', path: 'worker.mjs', contents: out.outputFiles[0]!.text }],
      compatibilityDate: '2026-10-28',
      compatibilityFlags: ['nodejs_compat'],
      r2Buckets: ['BUCKET'],
    }),
  );
  await mf.ready;
}, 60_000);
afterAll(async () => mf?.dispose());

type PutResult = { ok: boolean; sha256?: string; rejected?: string | null; error?: string };
async function put(bytes: Uint8Array, q: Record<string, string>): Promise<PutResult> {
  const qs = new URLSearchParams(q);
  const r = await mf.dispatchFetch(`http://test/put?${qs}`, { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
  return (await r.json()) as PutResult;
}
async function head(key: string) {
  const r = await mf.dispatchFetch(`http://test/head?key=${key}`);
  return (await r.json()) as { size: number; contentType: string; sha256: string; nativeDigest: boolean } | null;
}

describe('R2 adapter + upload pipeline in workerd', () => {
  it('streams a valid PNG into R2 unchanged, with a native SHA-256 that matches', async () => {
    const png = trackingPng();
    const sha = await sha256Hex(png);
    const r = await put(png, { key: 'ok.png', role: 'tracking-image', type: 'image/png', r2sha: sha, sha });
    expect(r).toEqual({ ok: true, sha256: sha });
    expect(await head('ok.png')).toEqual({ size: png.length, contentType: 'image/png', sha256: sha, nativeDigest: true });
  });

  it('streams a 3 MB GLB (larger than the head window)', async () => {
    const glb = makeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 3 * 1024 * 1024 }] }, new Uint8Array(3 * 1024 * 1024).fill(9));
    const r = await put(glb, { key: 'big.glb', role: 'model', type: 'model/gltf-binary' });
    expect(r.ok).toBe(true);
    expect((await head('big.glb'))?.size).toBe(glb.length);
  });

  it('stores nothing when the head is rejected', async () => {
    const html = new TextEncoder().encode('<html>'.padEnd(4096, ' '));
    expect(await put(html, { key: 'spoof.png', role: 'display-image', type: 'image/png' })).toMatchObject({ ok: false, rejected: 'signature_mismatch' });
    expect(await head('spoof.png')).toBeNull();
  });

  it('stores nothing when the tail or the checksum is wrong (failure at the very end of the stream)', async () => {
    const cut = trackingPng().slice(0, -12);
    expect(await put(cut, { key: 'cut.png', role: 'display-image', type: 'image/png' })).toMatchObject({ ok: false, rejected: 'corrupt' });
    expect(await head('cut.png')).toBeNull();
    const png = trackingPng();
    expect(await put(png, { key: 'sum.png', role: 'display-image', type: 'image/png', sha: '0'.repeat(64) })).toMatchObject({ ok: false, rejected: 'checksum_mismatch' });
    expect(await head('sum.png')).toBeNull();
  });

  it('R2 itself refuses a body that does not match the declared checksum', async () => {
    const png = trackingPng();
    const r = await put(png, { key: 'r2sum.png', role: 'display-image', type: 'image/png', r2sha: 'f'.repeat(64) });
    expect(r.ok).toBe(false);
    expect(await head('r2sum.png')).toBeNull();
  });

  it('a failed overwrite leaves the existing object intact', async () => {
    const png = trackingPng();
    expect((await put(png, { key: 'keep.png', role: 'display-image', type: 'image/png' })).ok).toBe(true);
    const before = await head('keep.png');
    expect((await put(png.slice(0, -12), { key: 'keep.png', role: 'display-image', type: 'image/png' })).ok).toBe(false);
    expect(await head('keep.png')).toEqual(before);
  });
});

/** Unit tests: content inspection, the streaming pipeline, signed URLs, filename/key safety (ADR-022). */
import { describe, expect, it } from 'vitest';
import { alphaPng, chunked, hugePng, makeGlb, narrowPng, photoJpeg, sha256Hex, trackingPng } from '../../test/files.ts';
import { inspectGlb, inspectHead, inspectTail, sniff } from './inspect.ts';
import { UploadRejected, createUploadPipeline } from './pipeline.ts';
import { originalKey, sanitizeFilename } from './routes.ts';
import { MAX_TTL_SECONDS, assetSigningKey, signAssetUrl, verifyAssetUrl } from './signing.ts';
import { memoryStore } from './store.ts';

describe('inspectHead', () => {
  it('detects real types from signatures, never from the declared type', () => {
    expect(sniff(trackingPng())).toBe('image/png');
    expect(sniff(photoJpeg())).toBe('image/jpeg');
    expect(sniff(makeGlb())).toBe('model/gltf-binary');
    expect(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it('accepts images and reports dimensions and alpha capability', () => {
    const png = inspectHead('display-image', 'image/png', alphaPng(), alphaPng().length);
    expect(png).toMatchObject({ ok: true, mime: 'image/png', metadata: { width: 512, height: 512, mayHaveAlpha: true } });
    const jpg = inspectHead('tracking-image', 'image/jpeg', photoJpeg(), photoJpeg().length);
    expect(jpg).toMatchObject({ ok: true, mime: 'image/jpeg', metadata: { width: 640, height: 427, mayHaveAlpha: false } });
  });

  it('rejects spoofed content types, wrong roles and unknown formats', () => {
    expect(inspectHead('display-image', 'image/jpeg', trackingPng(), 100)).toMatchObject({ ok: false, code: 'type_mismatch' });
    expect(inspectHead('model', 'model/gltf-binary', trackingPng(), 100)).toMatchObject({ ok: false, code: 'signature_mismatch' });
    expect(inspectHead('display-image', 'image/png', makeGlb(), 100)).toMatchObject({ ok: false, code: 'signature_mismatch' });
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    expect(inspectHead('display-image', 'image/png', html, html.length)).toMatchObject({ ok: false, code: 'signature_mismatch' });
  });

  it('rejects decompression-bomb dimensions before decoding', () => {
    expect(inspectHead('display-image', 'image/png', hugePng(), hugePng().length)).toMatchObject({ ok: false, code: 'dimensions_out_of_range' });
    expect(inspectHead('display-image', 'image/png', hugePng(8192, 8193), 45)).toMatchObject({ ok: false, code: 'dimensions_out_of_range' });
  });

  it('enforces the tracking-image minimum edge and warns about weak targets', () => {
    expect(inspectHead('tracking-image', 'image/png', narrowPng(), narrowPng().length)).toMatchObject({ ok: false, code: 'dimensions_out_of_range' });
    expect(inspectHead('display-image', 'image/png', narrowPng(), narrowPng().length)).toMatchObject({ ok: true });
    const ok = inspectHead('tracking-image', 'image/jpeg', photoJpeg(), photoJpeg().length);
    expect(ok.ok && ok.warnings.join(' ')).toMatch(/480 pixels/);
    const big = inspectHead('tracking-image', 'image/png', trackingPng(), trackingPng().length);
    expect(big.ok && big.warnings).toEqual([]);
  });

  it('rejects a corrupt image header', () => {
    const broken = trackingPng().slice(0, 20); // signature but no complete IHDR
    expect(inspectHead('display-image', 'image/png', broken, broken.length)).toMatchObject({ ok: false, code: 'corrupt' });
  });
});

describe('inspectGlb', () => {
  it('accepts a self-contained GLB and summarises it', () => {
    const glb = makeGlb();
    expect(inspectGlb(glb, glb.length)).toMatchObject({ ok: true, metadata: { gltfVersion: '2.0', generator: 'test', meshes: 1, materials: 2, textures: 0, extensionsRequired: [] } });
  });

  it('accepts embedded data: URIs but rejects external or remote references', () => {
    const embedded = makeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AQIDBA==' }] }, null);
    expect(inspectGlb(embedded, embedded.length).ok).toBe(true);
    for (const uri of ['https://evil.example/x.bin', 'textures/a.png', 'file:///etc/passwd', '//evil.example/a', 'data:text/html,<script>']) {
      const glb = makeGlb({ asset: { version: '2.0' }, images: [{ uri }] }, null);
      expect(inspectGlb(glb, glb.length), uri).toMatchObject({ ok: false, code: 'external_reference' });
    }
  });

  it('rejects truncation, wrong versions, bad JSON and missing binary chunks', () => {
    const glb = makeGlb();
    expect(inspectGlb(glb, glb.length + 4)).toMatchObject({ ok: false, code: 'corrupt' }); // header length ≠ size
    const v1 = glb.slice();
    v1[4] = 1;
    expect(inspectGlb(v1, v1.length)).toMatchObject({ ok: false, code: 'signature_mismatch' });
    const noBin = makeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] }, null);
    expect(inspectGlb(noBin, noBin.length)).toMatchObject({ ok: false, code: 'corrupt' });
    const oldGltf = makeGlb({ asset: { version: '1.0' } }, null);
    expect(inspectGlb(oldGltf, oldGltf.length)).toMatchObject({ ok: false, code: 'corrupt' });
    const badJson = makeGlb({ asset: { version: '2.0' } }, null);
    badJson[20] = 0x7d; // '}' first → invalid JSON
    expect(inspectGlb(badJson, badJson.length)).toMatchObject({ ok: false, code: 'corrupt' });
  });

  it('warns when glTF extensions are required', () => {
    const glb = makeGlb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] }, null);
    const r = inspectGlb(glb, glb.length);
    expect(r.ok && r.warnings[0]).toMatch(/KHR_draco_mesh_compression/);
  });
});

describe('inspectTail', () => {
  it('requires the PNG end marker', () => {
    const png = trackingPng();
    expect(inspectTail('image/png', png.slice(-12))).toBeNull();
    expect(inspectTail('image/png', png.slice(-20, -8))).toMatchObject({ code: 'corrupt' });
    expect(inspectTail('image/jpeg', new Uint8Array([1, 2, 3]))).toBeNull(); // JPEG trailers vary; not checked
  });
});

async function run(bytes: Uint8Array, opts: Partial<Parameters<typeof createUploadPipeline>[0]> = {}) {
  const store = memoryStore();
  const p = createUploadPipeline({ role: 'display-image', declaredType: 'image/png', size: bytes.length, ...opts });
  try {
    await store.put('k', chunked(bytes).pipeThrough(p.transform), { size: opts.size ?? bytes.length, contentType: 'image/png' });
    return { stored: store.objects.get('k')?.bytes ?? null, outcome: p.outcome(), error: null };
  } catch (e) {
    return { stored: store.objects.get('k')?.bytes ?? null, outcome: null, error: e as Error };
  }
}

describe('upload pipeline', () => {
  it('passes the file through unchanged, with its SHA-256 and inspection', async () => {
    const png = trackingPng();
    const r = await run(png);
    expect(r.error).toBeNull();
    expect(r.stored).toEqual(png);
    expect(r.outcome).toMatchObject({ size: png.length, sha256: await sha256Hex(png), inspection: { mime: 'image/png', metadata: { width: 1200, height: 800 } } });
  });

  it('accepts a matching declared checksum and rejects a different one (nothing stored)', async () => {
    const png = trackingPng();
    expect((await run(png, { expectedSha256: await sha256Hex(png) })).error).toBeNull();
    const bad = await run(png, { expectedSha256: '0'.repeat(64) });
    expect(bad.error).toBeInstanceOf(UploadRejected);
    expect((bad.error as UploadRejected).code).toBe('checksum_mismatch');
    expect(bad.stored).toBeNull();
  });

  it('rejects at the head, before any byte reaches storage', async () => {
    const r = await run(new TextEncoder().encode('<svg onload="alert(1)"></svg>'.padEnd(5000, ' ')));
    expect((r.error as UploadRejected).code).toBe('signature_mismatch');
    expect(r.stored).toBeNull();
  });

  it('rejects bodies longer or shorter than declared', async () => {
    const png = trackingPng();
    const longer = await run(png, { size: png.length - 1 });
    expect((longer.error as UploadRejected).code).toBe('size_mismatch');
    const shorter = await run(png.slice(0, -1), { size: png.length });
    expect((shorter.error as UploadRejected).code).toBe('size_mismatch');
    expect(longer.stored).toBeNull();
    expect(shorter.stored).toBeNull();
  });

  it('rejects a truncated PNG whose head is fine (tail check)', async () => {
    const png = trackingPng().slice(0, -12);
    const r = await run(png);
    expect((r.error as UploadRejected).code).toBe('corrupt');
    expect(r.stored).toBeNull();
  });

  it('handles files larger than the head window', async () => {
    const glb = makeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 3 * 1024 * 1024 }] }, new Uint8Array(3 * 1024 * 1024).fill(7));
    const r = await run(glb, { role: 'model', declaredType: 'model/gltf-binary' });
    expect(r.error).toBeNull();
    expect(r.stored?.length).toBe(glb.length);
    expect(r.outcome?.sha256).toBe(await sha256Hex(glb));
  });
});

describe('signed read URLs', () => {
  const asset = { id: '6f1c1d39-6f37-4b4e-9d0e-1a2b3c4d5e6f', sha256: 'ab'.repeat(32) };
  const q = (url: string) => Object.fromEntries(new URL(url).searchParams) as { v: string; exp: string; sig: string };

  it('verifies its own signature until expiry', async () => {
    const key = await assetSigningKey('x'.repeat(40));
    const now = Date.UTC(2026, 10, 22);
    const s = await signAssetUrl(key, 'https://app.example', asset, 900, now);
    expect(s.url).toMatch(/^https:\/\/app\.example\/api\/assets\/6f1c1d39-[^?]+\/content\?v=abababababababab&exp=\d+&sig=[A-Za-z0-9_-]{43}$/);
    expect(await verifyAssetUrl(key, asset, q(s.url), now + 1000)).toEqual({ ok: true, expiresInSeconds: 899 });
    expect(await verifyAssetUrl(key, asset, q(s.url), now + 901_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects tampering, other assets, replaced content, other secrets and absurd lifetimes', async () => {
    const key = await assetSigningKey('x'.repeat(40));
    const s = q((await signAssetUrl(key, 'https://a', asset, 900)).url);
    expect((await verifyAssetUrl(key, asset, { ...s, exp: String(Number(s.exp) + 1) })).ok).toBe(false);
    expect((await verifyAssetUrl(key, { ...asset, id: '6f1c1d39-6f37-4b4e-9d0e-000000000000' }, s)).ok).toBe(false);
    expect((await verifyAssetUrl(key, { ...asset, sha256: 'cd'.repeat(32) }, s)).ok).toBe(false);
    expect((await verifyAssetUrl(await assetSigningKey('y'.repeat(40)), asset, s)).ok).toBe(false);
    expect(await verifyAssetUrl(key, asset, { ...s, sig: 'short' })).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyAssetUrl(key, asset, { v: s.v, exp: s.exp })).toEqual({ ok: false, reason: 'malformed' });
    const long = q((await signAssetUrl(key, 'https://a', asset, MAX_TTL_SECONDS + 60)).url);
    expect(await verifyAssetUrl(key, asset, long)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('names and keys', () => {
  it('sanitises display filenames', () => {
    expect(sanitizeFilename('C:\\Users\\me\\poster.png')).toBe('poster.png');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('invoice\u202Egnp.exe')).toBe('invoicegnp.exe');
    expect(sanitizeFilename('a\u0000b\nc.png')).toBe('abc.png');
    expect(sanitizeFilename('   ')).toBe('upload');
    expect(sanitizeFilename('x'.repeat(400)).length).toBe(255);
  });

  it('builds keys only from safe server-side ids', () => {
    expect(originalKey('abcDEF123_-', '6f1c1d39-6f37-4b4e-9d0e-1a2b3c4d5e6f')).toBe('users/abcDEF123_-/assets/6f1c1d39-6f37-4b4e-9d0e-1a2b3c4d5e6f/original');
    expect(() => originalKey('../other', '6f1c1d39-6f37-4b4e-9d0e-1a2b3c4d5e6f')).toThrow();
    expect(() => originalKey('u', '../../x')).toThrow();
  });
});

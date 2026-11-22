import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ImageObjectSettings, USD_CONVERTER_VERSION } from '@ar-creator/contracts';
import { assetSigningKey, signAssetUrl, verifyAssetUrl } from '../assets/signing.ts';
import { canonicalSettings, derivativeKey, imageObjectJobKey, settingsHash } from './pipeline.ts';
import { workflowInstanceId } from './runner.ts';
import { FRAME_TYPE, UsdConversionRejected, UsdConverterUnavailable, httpUsdConverter, imagePlaneQuery, parseFrame } from './usd.ts';

const frame = (meta: object, payload: Uint8Array) => {
  const j = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + j.length + payload.length);
  new DataView(out.buffer).setUint32(0, j.length);
  out.set(j, 4);
  out.set(payload, 4 + j.length);
  return out;
};

describe('converter version contract', () => {
  it('the Worker expects exactly the version the Python converter reports', () => {
    const py = readFileSync(fileURLToPath(new URL('../../../../services/usd-processor/usd_processor/image_plane.py', import.meta.url).href), 'utf8');
    expect(/CONVERTER_VERSION = "([^"]+)"/.exec(py)?.[1]).toBe(USD_CONVERTER_VERSION);
  });
});

describe('settings hashing and keys', () => {
  it('defaults applied → equal settings hash equally; any change changes the hash', async () => {
    const a = ImageObjectSettings.parse({ widthMeters: 0.5, shapeMode: 'flat', alphaMode: 'auto' });
    const b = ImageObjectSettings.parse({ orientation: 'upright', pivot: 'center', doubleSided: false, alphaCutoff: 0.5, alphaMode: 'auto', shapeMode: 'flat', widthMeters: 0.5 });
    expect(canonicalSettings(a)).toBe(canonicalSettings(b));
    expect(await settingsHash(a)).toBe(await settingsHash(b));
    for (const change of [{ widthMeters: 0.51 }, { alphaMode: 'BLEND' }, { alphaCutoff: 0.4 }, { doubleSided: true }, { pivot: 'bottom-center' }, { orientation: 'flat' }]) {
      expect(await settingsHash(ImageObjectSettings.parse({ ...a, ...change })), JSON.stringify(change)).not.toBe(await settingsHash(a));
    }
  });

  it('storage keys follow the owned layout and refuse unsafe components', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const h = 'a'.repeat(64);
    const k = await derivativeKey('user_1', id, h, 'v1', 'usdz');
    expect(k).toMatch(new RegExp(`^users/user_1/assets/${id}/derivatives/[0-9a-f]{64}/display\\.usdz$`));
    expect(await derivativeKey('user_1', id, h, 'v2', 'usdz')).not.toBe(k); // converter version is part of provenance
    await expect(derivativeKey('../x', id, h, 'v1', 'glb')).rejects.toThrow(/unsafe/);
    await expect(derivativeKey('u', 'nope', h, 'v1', 'glb')).rejects.toThrow(/unsafe/);
    await expect(derivativeKey('u', id, 'zz', 'v1', 'glb')).rejects.toThrow(/unsafe/);
    expect(imageObjectJobKey(id, h).length).toBeLessThanOrEqual(200);
    expect(workflowInstanceId(id, 2)).toBe(`${id}-a2`);
    expect(workflowInstanceId(id, 3).length).toBeLessThanOrEqual(100);
  });
});

describe('signed URL kinds', () => {
  it('a derivative signature never verifies as an asset signature (and vice versa)', async () => {
    const key = await assetSigningKey('x'.repeat(48));
    const a = { id: '11111111-2222-4333-8444-555555555555', sha256: 'b'.repeat(64) };
    const d = await signAssetUrl(key, 'https://app.example', a, 60, Date.now(), 'derivative');
    expect(d.url).toMatch(/^https:\/\/app\.example\/api\/derivatives\//);
    const q = Object.fromEntries(new URL(d.url).searchParams);
    expect((await verifyAssetUrl(key, a, q, Date.now(), 'derivative')).ok).toBe(true);
    expect(await verifyAssetUrl(key, a, q, Date.now(), 'asset')).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('USD converter client', () => {
  const params = { widthMeters: 0.5, alphaMode: 'BLEND' as const, alphaCutoff: 0.5, doubleSided: true, pivot: 'center' as const, orientation: 'upright' as const };

  it('builds the query the Python server expects', () => {
    expect(imagePlaneQuery(params)).toBe('width_m=0.5&alpha_mode=BLEND&alpha_cutoff=0.5&double_sided=1&pivot=center&orientation=upright');
  });

  it('parses frames and refuses malformed ones', () => {
    const { meta, usdz } = parseFrame(frame({ ok: true, n: 1 }, new Uint8Array([1, 2, 3])));
    expect(meta).toEqual({ ok: true, n: 1 });
    expect([...usdz]).toEqual([1, 2, 3]);
    expect(() => parseFrame(new Uint8Array([0, 0]))).toThrow(UsdConverterUnavailable);
    expect(() => parseFrame(new Uint8Array([0, 0, 0, 200, 1]))).toThrow(UsdConverterUnavailable);
  });

  it('maps responses: 200 frame → result, 4xx → rejected (not retried), 5xx/network → unavailable (retried)', async () => {
    const respond = (r: Response | Error) => httpUsdConverter(async (req) => {
      expect(req.headers.get('x-source-sha256')).toBe('c'.repeat(64));
      if (r instanceof Error) throw r;
      return r;
    });
    const ok = await respond(new Response(frame({ ok: true, sha256: 's', width_m: 0.5, height_m: 0.25, alpha_mode: 'BLEND', converter_version: USD_CONVERTER_VERSION, package_files: ['scene.usdc'] }, new Uint8Array([9])), { headers: { 'content-type': FRAME_TYPE } })).imagePlane(new Uint8Array([1]), params, 'c'.repeat(64));
    expect(ok).toMatchObject({ widthMeters: 0.5, heightMeters: 0.25, alphaMode: 'BLEND', packageFiles: ['scene.usdc'] });
    await expect(respond(Response.json({ ok: false, code: 'conversion_failed', error: 'nope' }, { status: 422 })).imagePlane(new Uint8Array([1]), params, 'c'.repeat(64))).rejects.toBeInstanceOf(UsdConversionRejected);
    await expect(respond(new Response('boom', { status: 500 })).imagePlane(new Uint8Array([1]), params, 'c'.repeat(64))).rejects.toBeInstanceOf(UsdConverterUnavailable);
    await expect(respond(new Response('x', { status: 200, headers: { 'content-type': 'text/html' } })).imagePlane(new Uint8Array([1]), params, 'c'.repeat(64))).rejects.toBeInstanceOf(UsdConverterUnavailable);
    await expect(respond(new TypeError('connection refused')).imagePlane(new Uint8Array([1]), params, 'c'.repeat(64))).rejects.toBeInstanceOf(UsdConverterUnavailable);
    await expect(
      respond(new Response(frame({ ok: false }, new Uint8Array()), { headers: { 'content-type': FRAME_TYPE } })).imagePlane(new Uint8Array([1]), params, 'c'.repeat(64)),
    ).rejects.toBeInstanceOf(UsdConversionRejected);
  });
});

describe('converter pool size (USD_CONVERTER_POOL)', () => {
  it('uses the configured size, clamped to 1..3; missing or malformed → 1', async () => {
    const { converterPool } = await import('./usd.ts');
    expect(converterPool({ USD_CONVERTER_POOL: '1' })).toBe(1);
    expect(converterPool({ USD_CONVERTER_POOL: '3' })).toBe(3);
    expect(converterPool({ USD_CONVERTER_POOL: '10' })).toBe(3);
    expect(converterPool({ USD_CONVERTER_POOL: '0' })).toBe(1);
    expect(converterPool({ USD_CONVERTER_POOL: 'many' })).toBe(1);
    expect(converterPool({})).toBe(1);
  });
});

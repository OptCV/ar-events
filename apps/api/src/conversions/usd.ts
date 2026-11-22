/**
 * Client for the OpenUSD converter (services/usd-processor/usd_processor/server.py, ADR-023). The same HTTP
 * protocol is spoken to the Cloudflare Container (via its Durable Object stub) and, in local development and
 * tests, to the converter image run by Docker. The Worker streams the source bytes in and stores the result;
 * the converter has no storage access and no credentials.
 */
import type { ResolvedAlphaMode } from '@ar-creator/schema';

export interface UsdImagePlaneParams {
  widthMeters: number;
  alphaMode: ResolvedAlphaMode;
  alphaCutoff: number;
  doubleSided: boolean;
  pivot: 'center' | 'bottom-center';
  orientation: 'upright' | 'flat';
}

export interface UsdImagePlaneResult {
  usdz: Uint8Array;
  sha256: string;
  widthMeters: number;
  heightMeters: number;
  alphaMode: string;
  converterVersion: string;
  packageFiles: string[];
  validationWarnings: string[];
  openusdValidatorsRun: number;
}

export interface UsdConverter {
  imagePlane(image: Uint8Array, params: UsdImagePlaneParams, sourceSha256: string): Promise<UsdImagePlaneResult>;
}

/** The converter refused the input or its output failed validation: retrying will not help. */
export class UsdConversionRejected extends Error {
  override name = 'UsdConversionRejected';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The converter could not be reached or failed unexpectedly: safe to retry. */
export class UsdConverterUnavailable extends Error {
  override name = 'UsdConverterUnavailable';
}

export const FRAME_TYPE = 'application/vnd.ar-creator.conversion';
/** Upper bound for a response frame's JSON part (the result metadata is a few KB). */
const MAX_META_BYTES = 1024 * 1024;

export function imagePlaneQuery(p: UsdImagePlaneParams): string {
  return new URLSearchParams({
    width_m: String(p.widthMeters),
    alpha_mode: p.alphaMode,
    alpha_cutoff: String(p.alphaCutoff),
    double_sided: p.doubleSided ? '1' : '0',
    pivot: p.pivot,
    orientation: p.orientation,
  }).toString();
}

/** Parse `u32be(len) + json + usdz`. */
export function parseFrame(body: Uint8Array): { meta: Record<string, unknown>; usdz: Uint8Array } {
  if (body.length < 4) throw new UsdConverterUnavailable('converter response is truncated');
  const n = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
  if (n > MAX_META_BYTES || 4 + n > body.length) throw new UsdConverterUnavailable('converter response frame is malformed');
  const meta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + n))) as Record<string, unknown>;
  return { meta, usdz: body.slice(4 + n) };
}

/**
 * Converter over any fetch-compatible transport: the Container stub's `fetch`, or global `fetch` to a local URL.
 * `origin` is only used to build the request URL (the Container ignores the host).
 */
export function httpUsdConverter(fetcher: (req: Request) => Promise<Response>, origin = 'http://usd-converter'): UsdConverter {
  return {
    async imagePlane(image, params, sourceSha256) {
      let res: Response;
      try {
        res = await fetcher(
          new Request(`${origin}/v1/image-plane?${imagePlaneQuery(params)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'content-length': String(image.byteLength), 'x-source-sha256': sourceSha256 },
            body: image,
          }),
        );
      } catch (e) {
        throw new UsdConverterUnavailable(`converter unreachable: ${(e as Error).message}`);
      }
      const type = res.headers.get('content-type') ?? '';
      if (res.status === 422 || res.status === 400 || res.status === 413) {
        const j = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
        throw new UsdConversionRejected(j.code ?? 'conversion_failed', j.error ?? `converter refused the image (${res.status})`);
      }
      if (res.status !== 200 || !type.startsWith(FRAME_TYPE)) {
        await res.body?.cancel();
        throw new UsdConverterUnavailable(`converter answered ${res.status}`);
      }
      const { meta, usdz } = parseFrame(new Uint8Array(await res.arrayBuffer()));
      if (meta.ok !== true) throw new UsdConversionRejected('validation_failed', 'the USDZ failed structural validation');
      return {
        usdz,
        sha256: String(meta.sha256),
        widthMeters: Number(meta.width_m),
        heightMeters: Number(meta.height_m),
        alphaMode: String(meta.alpha_mode),
        converterVersion: String(meta.converter_version),
        packageFiles: Array.isArray(meta.package_files) ? meta.package_files.map(String) : [],
        validationWarnings: Array.isArray(meta.validation_warnings) ? meta.validation_warnings.map(String) : [],
        openusdValidatorsRun: Number(meta.openusd_validators_run ?? 0),
      };
    },
  };
}

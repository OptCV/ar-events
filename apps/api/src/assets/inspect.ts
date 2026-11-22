/**
 * Content inspection for uploads (ADR-022). Pure functions over the first bytes ("head") and last bytes ("tail")
 * of a file, so the upload pipeline can decide BEFORE any byte is written to storage. The declared content type
 * is never trusted: the type is detected from the file signature and must match what the client declared.
 */
import { MIME, ROLE_POLICY, type AssetMime, type FileRejection, type UploadableRole } from '@ar-creator/contracts';
import { ImageFormatError, MAX_EDGE, MAX_PIXELS, readImageInfo } from '@ar-creator/image-to-ar';

export interface InspectionOk {
  ok: true;
  mime: AssetMime;
  metadata: Record<string, unknown>;
  warnings: string[];
}
export interface InspectionFailed {
  ok: false;
  code: FileRejection;
  message: string;
}
export type Inspection = InspectionOk | InspectionFailed;

/** Bytes buffered before deciding. Large enough for JPEG EXIF/ICC segments and typical glTF JSON chunks. */
export const HEAD_BYTES: Record<UploadableRole, number> = {
  'tracking-image': 1024 * 1024,
  'display-image': 1024 * 1024,
  model: 2 * 1024 * 1024,
};
export const TAIL_BYTES = 12;

const fail = (code: FileRejection, message: string): InspectionFailed => ({ ok: false, code, message });

/** Detect the real type from magic bytes (null = not a type we accept for any role). */
export function sniff(head: Uint8Array): AssetMime | null {
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return MIME.png;
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return MIME.jpeg;
  if (head.length >= 4 && head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46) return MIME.glb; // "glTF"
  return null;
}

export function inspectHead(role: UploadableRole, declared: string, head: Uint8Array, totalSize: number): Inspection {
  const policy = ROLE_POLICY[role];
  const detected = sniff(head);
  if (!detected || !(policy.types as readonly string[]).includes(detected)) {
    return fail('signature_mismatch', role === 'model' ? 'This file is not a binary glTF (.glb) model.' : 'This file is not a PNG or JPEG image.');
  }
  if (detected !== declared) return fail('type_mismatch', `The file contents (${detected}) do not match its declared type (${declared}).`);
  return detected === MIME.glb ? inspectGlb(head, totalSize) : inspectImage(role, head);
}

function inspectImage(role: UploadableRole, head: Uint8Array): Inspection {
  let info;
  try {
    info = readImageInfo(head);
  } catch (e) {
    if (e instanceof ImageFormatError && /exceeds limits/.test(e.message)) {
      return fail('dimensions_out_of_range', `Images can be at most ${MAX_EDGE} × ${MAX_EDGE} pixels (${Math.round(MAX_PIXELS / 1e6)} megapixels).`);
    }
    return fail('corrupt', 'The image header could not be read. The file may be damaged.');
  }
  const minEdge = ROLE_POLICY[role].minEdgePx ?? 1;
  const shortest = Math.min(info.width, info.height);
  if (shortest < minEdge) {
    return fail('dimensions_out_of_range', `${ROLE_POLICY[role].label}s need at least ${minEdge} pixels on the shortest side (this one has ${shortest}).`);
  }
  const warnings: string[] = [];
  if (role === 'tracking-image') {
    if (shortest < 480) warnings.push('Small tracking images are harder to recognise. Use at least 480 pixels on the shortest side.');
    const ratio = Math.max(info.width, info.height) / shortest;
    if (ratio > 4) warnings.push('Very narrow images track poorly. Prefer an aspect ratio closer to square.');
  }
  return { ok: true, mime: info.mime, metadata: { width: info.width, height: info.height, mayHaveAlpha: info.mayHaveAlpha }, warnings };
}

const GLB_JSON = 0x4e4f534a; // "JSON"
const GLB_BIN = 0x004e4942; // "BIN\0"

function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** Only embedded resources are allowed: a URI must be a base64 data: URI (no remote, file or relative references). */
function isEmbeddedUri(uri: unknown): boolean {
  return typeof uri === 'string' && /^data:[a-z0-9.+/-]*(;[a-z0-9=.+-]+)*;base64,/i.test(uri);
}

export function inspectGlb(head: Uint8Array, totalSize: number): Inspection {
  if (head.length < 20) return fail('corrupt', 'The model file is too short to be a GLB.');
  const version = u32le(head, 4);
  if (version !== 2) return fail('signature_mismatch', `Only glTF 2.0 binary files are supported (this file is version ${version}).`);
  if (u32le(head, 8) !== totalSize) return fail('corrupt', 'The GLB header length does not match the file size. The file may be truncated.');
  const jsonLength = u32le(head, 12);
  if (u32le(head, 16) !== GLB_JSON) return fail('corrupt', 'The GLB file does not start with a JSON chunk.');
  if (20 + jsonLength > totalSize) return fail('corrupt', 'The GLB JSON chunk is longer than the file.');
  if (20 + jsonLength > head.length) return fail('corrupt', 'The model description (glTF JSON) is too large.');
  let gltf: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(head.subarray(20, 20 + jsonLength)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    gltf = parsed as Record<string, unknown>;
  } catch {
    return fail('corrupt', 'The model description (glTF JSON) is not valid.');
  }
  const asset = gltf.asset as { version?: unknown; generator?: unknown } | undefined;
  if (typeof asset?.version !== 'string' || !asset.version.startsWith('2.')) return fail('corrupt', 'The model does not declare glTF version 2.');

  const list = (k: string): Record<string, unknown>[] => (Array.isArray(gltf[k]) ? (gltf[k] as Record<string, unknown>[]) : []);
  for (const kind of ['buffers', 'images'] as const) {
    for (const item of list(kind)) {
      if (item && typeof item === 'object' && 'uri' in item && !isEmbeddedUri(item.uri)) {
        return fail('external_reference', 'The model references external files or URLs. Export it as a self-contained .glb.');
      }
    }
  }
  const needsBin = list('buffers').some((b) => b && typeof b === 'object' && !('uri' in b));
  if (needsBin) {
    const o = 20 + jsonLength;
    if (o + 8 > totalSize) return fail('corrupt', 'The model is missing its binary data chunk.');
    if (o + 8 <= head.length && u32le(head, o + 4) !== GLB_BIN) return fail('corrupt', 'The model binary data chunk is invalid.');
  }
  const extensionsRequired = Array.isArray(gltf.extensionsRequired) ? gltf.extensionsRequired.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
  const warnings: string[] = [];
  if (extensionsRequired.length) warnings.push(`This model requires glTF extensions (${extensionsRequired.join(', ')}); some AR viewers may not display it.`);
  const metadata = {
    gltfVersion: asset.version.slice(0, 16),
    ...(typeof asset.generator === 'string' ? { generator: asset.generator.slice(0, 120) } : {}),
    meshes: list('meshes').length,
    materials: list('materials').length,
    textures: list('textures').length,
    animations: list('animations').length,
    extensionsRequired,
  };
  return { ok: true, mime: MIME.glb, metadata, warnings };
}

const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
/**
 * End-of-file integrity: a PNG must end with its IEND chunk (catches truncated uploads). JPEG is not checked:
 * many cameras append data after the end-of-image marker, and rejecting real photos is worse than the benefit.
 * GLB truncation is caught by the header length check.
 */
export function inspectTail(mime: AssetMime, tail: Uint8Array): InspectionFailed | null {
  if (mime === MIME.png && (tail.length < 12 || !PNG_IEND.every((b, i) => tail[tail.length - 12 + i] === b))) {
    return fail('corrupt', 'The PNG file is incomplete (no end marker). Try exporting it again.');
  }
  return null;
}

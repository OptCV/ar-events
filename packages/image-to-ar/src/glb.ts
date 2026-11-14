import { CONVERTER_VERSION, type ImageToArSettings, type ResolvedAlphaMode } from '@ar-creator/schema';
import { buildQuad } from './geometry.ts';
import { readImageInfo } from './imageInfo.ts';

export interface ImagePlaneGlbInput {
  /** Original image bytes. Embedded unmodified — never re-encoded, flattened or premultiplied. */
  image: Uint8Array;
  settings: Pick<ImageToArSettings, 'widthMeters' | 'pivot' | 'orientation' | 'doubleSided' | 'alphaCutoff'>;
  alphaMode: ResolvedAlphaMode;
  name?: string;
}

export interface ImagePlaneGlbResult {
  glb: Uint8Array;
  widthMeters: number;
  heightMeters: number;
  alphaMode: ResolvedAlphaMode;
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const pad4 = (n: number) => (n + 3) & ~3;

/** Build a self-contained, deterministic GLB image plane (IMAGE_TO_AR.md "Flat GLB generation"). */
export function buildImagePlaneGlb(input: ImagePlaneGlbInput): ImagePlaneGlbResult {
  const info = readImageInfo(input.image);
  if (info.mime === 'image/jpeg' && input.alphaMode !== 'OPAQUE') {
    throw new Error('JPEG has no alpha channel; alphaMode must be OPAQUE');
  }
  const quad = buildQuad(info.width, info.height, input.settings);

  // --- binary payload, each view 4-byte aligned
  const parts: { bytes: Uint8Array; target?: number }[] = [
    { bytes: new Uint8Array(quad.positions.buffer), target: ARRAY_BUFFER },
    { bytes: new Uint8Array(quad.normals.buffer), target: ARRAY_BUFFER },
    { bytes: new Uint8Array(quad.uvs.buffer), target: ARRAY_BUFFER },
    { bytes: new Uint8Array(quad.indices.buffer), target: ELEMENT_ARRAY_BUFFER },
    { bytes: input.image },
  ];
  let offset = 0;
  const bufferViews = parts.map((p) => {
    const view: Record<string, number> = { buffer: 0, byteOffset: offset, byteLength: p.bytes.byteLength };
    if (p.target !== undefined) view.target = p.target;
    offset = pad4(offset + p.bytes.byteLength);
    return view;
  });
  const binLength = offset;
  const bin = new Uint8Array(binLength);
  parts.forEach((p, i) => bin.set(p.bytes, bufferViews[i]!.byteOffset!));

  const name = input.name ?? 'image-object';
  const material: Record<string, unknown> = {
    name: `${name}-material`,
    pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
    alphaMode: input.alphaMode,
    doubleSided: input.settings.doubleSided,
  };
  if (input.alphaMode === 'MASK') material.alphaCutoff = input.settings.alphaCutoff;

  const gltf = {
    asset: { version: '2.0', generator: `ar-creator ${CONVERTER_VERSION}` },
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
    materials: [material],
    // CLAMP_TO_EDGE avoids wrap-around bleeding of opposite-edge pixels into transparent borders.
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    textures: [{ sampler: 0, source: 0 }],
    images: [{ bufferView: 4, mimeType: info.mime }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: quad.min, max: quad.max },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: binLength }],
    extras: {
      arCreator: {
        converterVersion: CONVERTER_VERSION,
        widthMeters: quad.widthMeters,
        heightMeters: quad.heightMeters,
        pixelWidth: info.width,
        pixelHeight: info.height,
      },
    },
  };

  const jsonRaw = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLen = pad4(jsonRaw.byteLength);
  const total = 12 + 8 + jsonLen + 8 + binLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonRaw, 20);
  out.fill(0x20, 20 + jsonRaw.byteLength, 20 + jsonLen); // JSON padding = spaces
  const binHeader = 20 + jsonLen;
  dv.setUint32(binHeader, binLength, true);
  dv.setUint32(binHeader + 4, CHUNK_BIN, true);
  out.set(bin, binHeader + 8);

  return { glb: out, widthMeters: quad.widthMeters, heightMeters: quad.heightMeters, alphaMode: input.alphaMode };
}

/** Minimal GLB reader for tests/diagnostics. */
export function readGlb(glb: Uint8Array): { json: any; bin: Uint8Array } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC || dv.getUint32(4, true) !== 2) throw new Error('not a glTF 2.0 GLB');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  const binLen = dv.getUint32(20 + jsonLen, true);
  const bin = glb.subarray(28 + jsonLen, 28 + jsonLen + binLen);
  return { json, bin };
}

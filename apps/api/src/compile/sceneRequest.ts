import type { DraftExperienceScene, SceneNode } from '@ar-creator/schema';

/**
 * Scene compile request for the converter container (Phase 5 M14, ADR-032): u32be(len) + manifest JSON + payload.
 * Mirrors services/usd-processor/usd_processor/scene/request.py; the container re-validates everything.
 */
export interface SceneFile {
  id: string;
  data: Uint8Array;
}

export interface FileRefs {
  /** File id for an image object's GLB (by derivative id), or null when it is not available. */
  imageObject: (derivativeId: string) => string | null;
  /** File id for an uploaded model (by asset id). */
  model: (assetId: string) => string | null;
  /** Image placement: the tracking image file id (needed for the USDZ reference image). */
  tracking?: string;
}

export class SceneRequestError extends Error {
  override name = 'SceneRequestError';
}

function manifestNode(n: SceneNode, refs: FileRefs): Record<string, unknown> {
  const base: Record<string, unknown> = { id: n.id, kind: n.kind, transform: n.transform, visible: n.visible !== false, ...(n.parentId !== undefined ? { parentId: n.parentId } : {}) };
  switch (n.kind) {
    case 'image-object': {
      const file = refs.imageObject(n.derivativeId);
      if (!file) throw new SceneRequestError(`image object ${n.id} is not available`);
      return { ...base, file };
    }
    case 'model': {
      const file = refs.model(n.assetId);
      if (!file) throw new SceneRequestError(`model ${n.id} is not available`);
      return { ...base, file };
    }
    case 'text':
      return { ...base, text: n.text, style: n.style };
    case 'panel':
      return { ...base, title: n.title, body: n.body };
    case 'primitive':
      return { ...base, shape: n.shape, ...(n.color !== undefined ? { color: n.color } : {}) };
    default:
      return base;
  }
}

export function sceneManifest(scene: Pick<DraftExperienceScene, 'placement' | 'nodes'>, refs: FileRefs) {
  const p = scene.placement;
  return {
    version: 1,
    placement: p.mode === 'image' ? { mode: 'image', trackingWidthMeters: p.physicalWidthMeters, ...(refs.tracking ? { trackingFile: refs.tracking } : {}) } : { mode: p.mode },
    nodes: scene.nodes.map((n) => manifestNode(n, refs)),
  };
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Frames a manifest and its files (each listed once, in order, with offset, length and SHA-256). */
export async function frameSceneRequest(manifest: object, files: SceneFile[]): Promise<Uint8Array> {
  const entries: Record<string, { offset: number; length: number; sha256: string }> = {};
  let offset = 0;
  for (const f of files) {
    entries[f.id] = { offset, length: f.data.byteLength, sha256: hex(await crypto.subtle.digest('SHA-256', f.data as Uint8Array<ArrayBuffer>)) };
    offset += f.data.byteLength;
  }
  const json = new TextEncoder().encode(JSON.stringify({ ...manifest, files: entries }));
  const out = new Uint8Array(4 + json.byteLength + offset);
  new DataView(out.buffer).setUint32(0, json.byteLength);
  out.set(json, 4);
  let o = 4 + json.byteLength;
  for (const f of files) {
    out.set(f.data, o);
    o += f.data.byteLength;
  }
  return out;
}

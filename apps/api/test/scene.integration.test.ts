/**
 * Phase 5 M14: scene compiler → composed GLB, through the real converter image (Docker, http://127.0.0.1:8790), checked
 * with the Khronos glTF Validator (the reference Scene Viewer's own validation builds on). Desktop/structural evidence
 * only — Scene Viewer and the WebXR viewer are device-tested separately.
 */
import { describe, expect, it } from 'vitest';
import { buildImagePlaneGlb, readGlb } from '@ar-creator/image-to-ar';
import { IDENTITY_TRANSFORM, type DraftExperienceScene, type SceneNode } from '@ar-creator/schema';
// @ts-expect-error - the validator ships without type declarations
import validator from 'gltf-validator';
import { frameSceneRequest, sceneManifest } from '../src/compile/sceneRequest.ts';
import { cubeGlb } from '../../../tests/e2e/app/glb.ts';
import { fixture, sha256Hex } from './files.ts';
import { LOCAL_USD_URL } from './harness.ts';

interface Report {
  issues: { numErrors: number; numWarnings: number; messages: { code: string; severity: number; message: string; pointer?: string }[] };
  info: { totalTriangleCount?: number; extensionsUsed?: string[]; animationCount?: number; materialCount?: number; drawCallCount?: number };
}
const validate = (glb: Uint8Array): Promise<Report> => validator.validateBytes(glb, { maxIssues: 100 });

async function compile(scene: Pick<DraftExperienceScene, 'placement' | 'nodes'>, files: { id: string; data: Uint8Array }[], refs: { io?: Record<string, string>; model?: Record<string, string> }) {
  const body = await frameSceneRequest(sceneManifest(scene, { imageObject: (id) => refs.io?.[id] ?? null, model: (id) => refs.model?.[id] ?? null }), files);
  const res = await fetch(`${LOCAL_USD_URL}/v1/scene/glb`, { method: 'POST', body: body as Uint8Array<ArrayBuffer> });
  const raw = new Uint8Array(await res.arrayBuffer());
  if (res.status !== 200) return { status: res.status, error: JSON.parse(new TextDecoder().decode(raw)) as { code: string; error: string } };
  const n = new DataView(raw.buffer).getUint32(0);
  return { status: 200, meta: JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + n))), glb: raw.subarray(4 + n) };
}

const T = (position: [number, number, number] = [0, 0, 0], scale = 1) => ({ ...IDENTITY_TRANSFORM, position, scale: [scale, scale, scale] as [number, number, number] });
const base = { visible: true, locked: false } as const;

describe('scene compiler: composed GLB (ADR-032)', () => {
  it('every node kind, a hierarchy and a hidden branch compose into one VALID GLB (0 validator errors)', async () => {
    const ring = fixture('ring_inner_hole.png');
    const io = buildImagePlaneGlb({ image: ring, settings: { widthMeters: 0.4, pivot: 'bottom-center', orientation: 'upright', doubleSided: false, alphaCutoff: 0.5 }, alphaMode: 'MASK' }).glb;
    const model = new Uint8Array(cubeGlb(0.3, 'Spin'));
    const nodes: SceneNode[] = [
      { ...base, id: 'ring', kind: 'image-object', derivativeId: 'd1', transform: T([-0.4, 0, 0]) },
      { ...base, id: 'cube', kind: 'model', assetId: 'a1', transform: T([0.4, 0.15, 0]) },
      { ...base, id: 'cube2', kind: 'model', assetId: 'a1', transform: T([0.8, 0.15, 0], 0.5) },
      { ...base, id: 'group', kind: 'group', transform: T([0, 0.5, 0]) },
      { ...base, id: 'title', kind: 'text', parentId: 'group', text: 'Hello AR', style: { color: '#c0392b', sizeMeters: 0.08 }, transform: T() },
      { ...base, id: 'card', kind: 'panel', title: 'Opening hours', body: 'Monday to Friday, 9:00 to 17:00.', transform: T([0, 0.2, -0.3]) },
      ...(['box', 'sphere', 'cylinder', 'plane'] as const).map((shape, i): SceneNode => ({ ...base, id: `s-${shape}`, kind: 'primitive', shape, color: '#2a8a3e', transform: T([i * 0.3, 0.1, 0.5], 0.2) })),
      { ...base, id: 'pin', kind: 'hotspot', actionId: 'x', transform: T([0, 0.3, 0]) },
      { ...base, id: 'off', kind: 'group', visible: false, transform: T() },
      { ...base, id: 'off-child', kind: 'primitive', shape: 'box', parentId: 'off', transform: T() },
    ];
    const r = await compile({ placement: { mode: 'floor' }, nodes }, [{ id: 'f-io', data: io }, { id: 'f-m', data: model }], { io: { d1: 'f-io' }, model: { a1: 'f-m' } });
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    const report = await validate(r.glb!);
    expect(report.issues.numErrors, JSON.stringify(report.issues.messages.filter((m) => m.severity === 0))).toBe(0);
    // Warnings are listed for the record; none is about broken data.
    expect(report.issues.messages.filter((m) => m.severity === 1).map((m) => m.code)).toEqual([]);
    expect(report.info.extensionsUsed).toEqual(['KHR_materials_unlit']);
    expect(report.info.animationCount).toBe(2);
    expect(r.meta).toMatchObject({ ok: true, compilerVersion: 'scene-glb@0.1.0', nodeIds: ['ring', 'cube', 'cube2', 'group', 'title', 'card', 's-box', 's-sphere', 's-cylinder', 's-plane', 'pin'] });
    expect(r.meta.triangles).toBe(report.info.totalTriangleCount);
    expect(r.meta.sha256).toBe(await sha256Hex(r.glb!));

    // The image object's picture is embedded unchanged (byte-identical to the upload), alpha mode kept.
    const { json, bin } = readGlb(r.glb!);
    const ringMat = json.materials.find((m: { alphaMode?: string }) => m.alphaMode === 'MASK');
    const img = json.images[json.textures[ringMat.pbrMetallicRoughness.baseColorTexture.index].source];
    const view = json.bufferViews[img.bufferView];
    expect(await sha256Hex(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength))).toBe(await sha256Hex(ring));
    // Scene ids on the wrapper nodes, hierarchy kept, transforms as authored.
    const byName = new Map<string, { name: string; children?: number[]; translation?: number[]; scale?: number[]; extras?: unknown }>(json.nodes.map((n: { name: string }) => [n.name, n]));
    expect(byName.get('cube2')).toMatchObject({ translation: [0.8, 0.15, 0], scale: [0.5, 0.5, 0.5], extras: { arCreator: { nodeId: 'cube2', kind: 'model' } } });
    expect(json.nodes[byName.get('group')!.children![0]!].name).toBe('title');
    expect(byName.has('off')).toBe(false);
    expect(byName.has('off-child')).toBe(false);
  });

  it('identical input → identical bytes; refusals are explained', async () => {
    const nodes: SceneNode[] = [{ ...base, id: 't', kind: 'text', text: 'Same', style: { color: '#000000', sizeMeters: 0.05 }, transform: T() }];
    const a = await compile({ placement: { mode: 'wall' }, nodes }, [], {});
    const b = await compile({ placement: { mode: 'wall' }, nodes }, [], {});
    expect(await sha256Hex(a.glb!)).toBe(await sha256Hex(b.glb!));

    const empty = await compile({ placement: { mode: 'floor' }, nodes: [{ ...nodes[0]!, visible: false }] }, [], {});
    expect(empty).toMatchObject({ status: 422, error: { code: 'empty_scene' } });
    const notGlb = await compile({ placement: { mode: 'floor' }, nodes: [{ ...base, id: 'm', kind: 'model', assetId: 'a', transform: T() }] }, [{ id: 'f', data: fixture('ring_inner_hole.png') }], { model: { a: 'f' } });
    expect(notGlb).toMatchObject({ status: 422, error: { code: 'bad_file' } });
    expect(() => sceneManifest({ placement: { mode: 'floor' }, nodes: [{ ...base, id: 'm', kind: 'model', assetId: 'missing', transform: T() }] }, { imageObject: () => null, model: () => null })).toThrow(/not available/);
  });
});

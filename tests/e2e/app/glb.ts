/**
 * Valid, self-contained test GLBs built at runtime (no large fixtures in git): one mesh, one untextured PBR material.
 */
function build(positions: Float32Array, indices: Uint32Array, name: string, clip?: string): Buffer {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, positions[i + k]!);
      max[k] = Math.max(max[k]!, positions[i + k]!);
    }
  const pos = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
  const idx = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
  // Optional animation: one rotation clip (2 keyframes) on the mesh node.
  const times = Buffer.from(new Float32Array([0, 1]).buffer);
  const rots = Buffer.from(new Float32Array([0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2]).buffer);
  const bin = clip ? Buffer.concat([pos, idx, times, rots]) : Buffer.concat([pos, idx]); // all 4-byte aligned
  const gltf = {
    asset: { version: '2.0', generator: 'ar-creator e2e' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ name: `${name}-material`, pbrMetallicRoughness: { baseColorFactor: [0.2, 0.5, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' },
      ...(clip
        ? [
            { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
            { bufferView: 3, componentType: 5126, count: 2, type: 'VEC4' },
          ]
        : []),
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 },
      { buffer: 0, byteOffset: pos.length, byteLength: idx.length, target: 34963 },
      ...(clip
        ? [
            { buffer: 0, byteOffset: pos.length + idx.length, byteLength: times.length },
            { buffer: 0, byteOffset: pos.length + idx.length + times.length, byteLength: rots.length },
          ]
        : []),
    ],
    ...(clip ? { animations: [{ name: clip, channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }], samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }] }] } : {}),
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (len: number, type: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([head, chunk(json.length, 0x4e4f534a), json, chunk(bin.length, 0x004e4942), bin]);
}

/** A cube `edge` meters wide, centred on its origin: 8 vertices, 12 triangles. */
export function cubeGlb(edge = 0.3, clip?: string): Buffer {
  const h = edge / 2;
  const p = new Float32Array([-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h]);
  const i = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return build(p, i, 'cube', clip);
}

/** A flat 1 m grid of `n` × `n` quads: 2·n² triangles (n = 250 → 125,000). */
export function gridGlb(n = 250): Buffer {
  const v = n + 1;
  const p = new Float32Array(v * v * 3);
  for (let y = 0; y < v; y++)
    for (let x = 0; x < v; x++) {
      const k = (y * v + x) * 3;
      p[k] = x / n - 0.5;
      p[k + 1] = 0;
      p[k + 2] = y / n - 0.5;
    }
  const i = new Uint32Array(n * n * 6);
  let o = 0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * v + x;
      i.set([a, a + v, a + 1, a + 1, a + v, a + v + 1], o);
      o += 6;
    }
  return build(p, i, 'grid');
}

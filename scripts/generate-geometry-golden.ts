/** Writes tests/fixtures/geometry_golden.json — the shared GLB/USD quad contract. Change only with an ADR. */
import { writeFileSync } from 'node:fs';
import { buildQuad } from '../packages/image-to-ar/src/geometry.ts';

const cases = [];
for (const [pw, ph, w] of [[600, 400, 0.3], [101, 701, 0.25], [903, 117, 1.2], [640, 427, 0.5]] as const)
  for (const pivot of ['center', 'bottom-center'] as const)
    for (const orientation of ['upright', 'flat'] as const) {
      const q = buildQuad(pw, ph, { widthMeters: w, pivot, orientation });
      cases.push({
        pixelWidth: pw,
        pixelHeight: ph,
        widthMeters: w,
        pivot,
        orientation,
        heightMeters: q.heightMeters,
        positions: Array.from(q.positions),
        uvs: Array.from(q.uvs),
        indices: Array.from(q.indices),
        normal: Array.from(q.normals.slice(0, 3)),
      });
    }

const note = 'Shared GLB/USD quad golden (float32 positions). Regenerate only with an ADR-backed geometry change.';
writeFileSync(new URL('../tests/fixtures/geometry_golden.json', import.meta.url), JSON.stringify({ note, cases }, null, 1) + '\n');

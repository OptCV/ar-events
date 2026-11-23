import { describe, expect, it } from 'vitest';
import { BUDGET, budgetIssues, sceneTotals, wrapText } from './budgets.ts';

const ok = { triangles: 2, materials: 1, textures: 1, maxTexturePx: 512 };

describe('budgets (M11)', () => {
  it('has nothing to say within the Scene Viewer guidance', () => {
    expect(budgetIssues(ok, 1024, 'object')).toEqual([]);
    expect(budgetIssues(ok, null, 'object')).toEqual([]);
  });

  it('warns on triangles, materials, texture size and file size; errors over 15 MB', () => {
    const big = { triangles: 150_000, materials: 12, textures: 3, maxTexturePx: 4096 };
    expect(budgetIssues(big, 11 * 1024 * 1024, 'object').map((i) => [i.level, i.message])).toEqual([
      ['warning', 'This object has 150,000 triangles; Scene Viewer recommends at most 100,000.'],
      ['warning', 'This object has 12 materials; Scene Viewer recommends at most 10.'],
      ['warning', "A texture is 4,096 px; Scene Viewer's maximum is 2,048 px, so it may be shown blurred or not at all."],
      ['warning', 'The file is 11.0 MB; Scene Viewer recommends at most 10.0 MB.'],
    ]);
    expect(budgetIssues(ok, BUDGET.bytesMax + 1, 'scene')).toEqual([{ level: 'error', message: "The scene files total 15.0 MB; Scene Viewer refuses files over 15.0 MB." }]);
    expect(budgetIssues({ ...ok, triangles: BUDGET.trianglesWarn }, BUDGET.bytesWarn, 'object')).toEqual([]); // limits are inclusive
  });

  it('adds per-object counts per copy but counts each file once', () => {
    const t = sceneTotals([
      { stats: { triangles: 2, materials: 1, textures: 1, maxTexturePx: 512 }, file: { key: 'io:a', bytes: 1000 } },
      { stats: { triangles: 2, materials: 1, textures: 1, maxTexturePx: 512 }, file: { key: 'io:a', bytes: 1000 } },
      { stats: { triangles: 5000, materials: 3, textures: 2, maxTexturePx: 2048 }, file: { key: 'model:b', bytes: 5000 } },
      { stats: { triangles: 12, materials: 1, textures: 0, maxTexturePx: 0 }, file: null },
    ]);
    expect(t).toEqual({ stats: { triangles: 5016, materials: 6, textures: 4, maxTexturePx: 2048 }, bytes: 6000 });
  });

  it('wraps words to a width, keeps newlines and breaks words that are too long', () => {
    const m = (s: string) => s.length; // one unit per character
    expect(wrapText('the quick brown fox', 10, m)).toEqual(['the quick', 'brown fox']);
    expect(wrapText('a\n\nb', 10, m)).toEqual(['a', '', 'b']);
    expect(wrapText('abcdefghijklmnop', 6, m)).toEqual(['abcdef', 'ghijkl', 'mnop']);
    expect(wrapText('', 6, m)).toEqual(['']);
  });
});

/**
 * Per-object and per-scene budgets (Phase 3 M11, ADR-029). Numbers are Google's Scene Viewer file requirements
 * (https://developers.google.com/ar/develop/scene-viewer, "File requirements for models" and the validation table,
 * read 2026-11-22): the strictest published guidance among our viewers. Quick Look publishes no hard numbers; its
 * behaviour is device-tested separately (TESTING.md). These are advice, except the 15 MB composed-file limit.
 */
export const BUDGET = {
  /** "The recommended limit is 100,000 triangles"; 30k–50k ideal. */
  trianglesWarn: 100_000,
  /** "The recommended limit is 10 materials". */
  materialsWarn: 10,
  /** "Maximum texture resolution: 2048 × 2048" (a warning in the validator). */
  texturePx: 2048,
  /** 10 MB recommended; MAX_INPUT_BINARY_SIZE_EXCEEDED at 15 MB is an error. */
  bytesWarn: 10 * 1024 * 1024,
  bytesMax: 15 * 1024 * 1024,
} as const;

export interface ObjectStats {
  triangles: number;
  materials: number;
  textures: number;
  /** Longest texture edge in pixels (0 when untextured). */
  maxTexturePx: number;
}

export interface BudgetIssue {
  level: 'warning' | 'error';
  message: string;
}

const MB = 1024 * 1024;
const fmtMB = (b: number) => `${(b / MB).toFixed(1)} MB`;
const n = (v: number) => v.toLocaleString('en-US');

/** What exceeds the budget. `bytes` = file size(s), null when unknown (built-in text, panels and shapes). */
export function budgetIssues(stats: ObjectStats, bytes: number | null, scope: 'object' | 'scene'): BudgetIssue[] {
  const where = scope === 'scene' ? 'The scene has' : 'This object has';
  const out: BudgetIssue[] = [];
  if (stats.triangles > BUDGET.trianglesWarn) out.push({ level: 'warning', message: `${where} ${n(stats.triangles)} triangles; Scene Viewer recommends at most ${n(BUDGET.trianglesWarn)}.` });
  if (stats.materials > BUDGET.materialsWarn) out.push({ level: 'warning', message: `${where} ${stats.materials} materials; Scene Viewer recommends at most ${BUDGET.materialsWarn}.` });
  if (stats.maxTexturePx > BUDGET.texturePx) out.push({ level: 'warning', message: `A texture is ${n(stats.maxTexturePx)} px; Scene Viewer's maximum is ${n(BUDGET.texturePx)} px, so it may be shown blurred or not at all.` });
  if (bytes !== null && bytes > BUDGET.bytesMax) out.push({ level: 'error', message: `${scope === 'scene' ? 'The scene files total' : 'The file is'} ${fmtMB(bytes)}; Scene Viewer refuses files over ${fmtMB(BUDGET.bytesMax)}.` });
  else if (bytes !== null && bytes > BUDGET.bytesWarn) out.push({ level: 'warning', message: `${scope === 'scene' ? 'The scene files total' : 'The file is'} ${fmtMB(bytes)}; Scene Viewer recommends at most ${fmtMB(BUDGET.bytesWarn)}.` });
  return out;
}

/**
 * Scene totals: triangles, materials and textures add up per placed object (each copy is drawn); file bytes count each
 * distinct file once (the same file placed twice is stored once).
 */
export function sceneTotals(items: { stats: ObjectStats; file: { key: string; bytes: number | null } | null }[]): { stats: ObjectStats; bytes: number } {
  const stats: ObjectStats = { triangles: 0, materials: 0, textures: 0, maxTexturePx: 0 };
  const files = new Map<string, number>();
  for (const i of items) {
    stats.triangles += i.stats.triangles;
    stats.materials += i.stats.materials;
    stats.textures += i.stats.textures;
    stats.maxTexturePx = Math.max(stats.maxTexturePx, i.stats.maxTexturePx);
    if (i.file && i.file.bytes !== null) files.set(i.file.key, i.file.bytes);
  }
  return { stats, bytes: [...files.values()].reduce((a, b) => a + b, 0) };
}

/**
 * Greedy word wrap with an injected measure (canvas in the browser, a stub in tests). Explicit newlines are kept;
 * a word longer than the width is broken by characters.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      let rest = word;
      while (measure(rest) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

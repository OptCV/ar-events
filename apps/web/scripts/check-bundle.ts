/**
 * Bundle budgets (Phase 6 M20, ADR-038). Builds the client with a manifest (never deployed: it is deleted after the
 * check), then sums the gzip size of the JavaScript each key page downloads before it can render: the entry plus
 * the static imports of its route chunk (lazily loaded parts such as the 3D preview are budgeted separately, as
 * shell + their own chunks). Budgets are the sizes measured on 2026-11-23 plus ~10 %: they catch growth.
 *
 *   npm run check:bundle -w @ar-creator/web
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const DIST = new URL('../dist/client/', import.meta.url);
const BUDGETS_KB: Record<string, { entry: string; kb: number; note: string }> = {
  shell: { entry: 'index.html', kb: 165, note: 'every page: React, React Router, TanStack Query, Zod, session' },
  'public page': { entry: 'src/builds/TestBuildPage.tsx', kb: 180, note: 'what a visitor of /x/{slug} or /test/{id} loads first' },
  'print sheet': { entry: 'src/builds/PrintSheet.tsx', kb: 165, note: '/x/{slug}/print' },
  editor: { entry: 'src/experiences/ExperiencePage.tsx', kb: 210, note: 'the experience editor' },
  '3D preview': { entry: 'src/imageObjects/ModelPreview.tsx', kb: 345, note: 'lazy: three.js + GLTFLoader' },
  'image viewer': { entry: 'src/builds/xr/ImageViewer.tsx', kb: 360, note: 'lazy: Android WebXR image tracking' },
};

execFileSync('npx', ['vite', 'build'], { cwd: new URL('..', import.meta.url), env: { ...process.env, BUNDLE_MANIFEST: '1' }, stdio: 'ignore', shell: true });
type Chunk = { file: string; imports?: string[]; isEntry?: boolean };
const manifestUrl = new URL('.vite/manifest.json', DIST);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as Record<string, Chunk>;
rmSync(new URL('.vite/', DIST), { recursive: true, force: true });

const gz = new Map<string, number>();
const size = (file: string) => {
  if (!gz.has(file)) gz.set(file, gzipSync(readFileSync(new URL(file, DIST))).length);
  return gz.get(file)!;
};
const closure = (key: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const i of manifest[key]?.imports ?? []) closure(i, seen);
  return seen;
};
const shell = closure('index.html');

let failed = false;
for (const [name, b] of Object.entries(BUDGETS_KB)) {
  if (!manifest[b.entry]) {
    console.error(`✗ ${name}: ${b.entry} is not a chunk any more (update the budget list)`);
    failed = true;
    continue;
  }
  const keys = name === 'shell' ? shell : new Set([...shell, ...closure(b.entry)]);
  const kb = [...keys].reduce((s, k) => s + (manifest[k]!.file.endsWith('.js') ? size(manifest[k]!.file) : 0), 0) / 1000;
  const ok = kb <= b.kb;
  failed ||= !ok;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(13)} ${kb.toFixed(1).padStart(6)} kB gzip  (budget ${b.kb} kB — ${b.note})`);
}
process.exit(failed ? 1 : 0);

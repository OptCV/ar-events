/**
 * P0 runtime-proof kit (ROADMAP.md P0, TESTING.md device matrix).
 * Builds matched GLB + USDZ pairs from golden fixtures and a static device-lab page whose launch
 * links come from @ar-creator/platform-launch (the single audited launch utility).
 *
 *   P0_BASE_URL=https://<your-host> npm run p0:build      → out/p0/
 *
 * The page is a TEST HARNESS. Opening it proves nothing until a human records device results in TESTING.md.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ImageToArSettings, type ImageToArSettingsInput } from '@ar-creator/schema';
import { analyzeAlpha, buildImagePlaneGlb, readImageInfo, resolveAlphaMode } from '@ar-creator/image-to-ar';
import { buildQuickLookHref, buildSceneViewerIntent } from '@ar-creator/platform-launch';
import { build as viteBuild } from 'vite';
import { IMAGE, ROOT, SANDBOX, docker, mount } from './usd.ts';

interface Case {
  id: string;
  matrix: string[];
  title: string;
  fixture: string;
  anchor: 'image' | 'floor' | 'wall';
  settings: ImageToArSettingsInput;
  expect: string;
  link?: string;
}

const T = 'tracking_target_20cm.png';
const CASES: Case[] = [
  {
    id: 'img-overlay',
    matrix: ['IOS-IMG-01', 'AND-IMG-01'],
    title: 'Image anchor: probe card exactly covers the printed 20 cm target',
    fixture: 'orientation_probe.png',
    anchor: 'image',
    settings: { widthMeters: 0.2, shapeMode: 'flat', alphaMode: 'auto', orientation: 'flat' },
    expect: 'Card lies flat on the print, same size (20 cm), arrow toward the top of the print, red top-left. Records image-frame axes.',
  },
  {
    id: 'floor-probe',
    matrix: ['IOS-FLR-01', 'AND-FLR-01'],
    title: 'Floor: upright probe card standing on the floor',
    fixture: 'orientation_probe.png',
    anchor: 'floor',
    settings: { widthMeters: 0.6, shapeMode: 'flat', alphaMode: 'auto', pivot: 'bottom-center', orientation: 'upright' },
    expect: 'Card 60x40 cm stands on the floor, bottom edge touching the floor, arrow pointing up, readable from the front.',
  },
  {
    id: 'wall-probe',
    matrix: ['IOS-WAL-01', 'AND-WAL-01'],
    title: 'Wall: probe card flush against a wall',
    fixture: 'orientation_probe.png',
    anchor: 'wall',
    settings: { widthMeters: 0.6, shapeMode: 'flat', alphaMode: 'auto', orientation: 'upright' },
    expect: 'Card 60x40 cm flush on the wall facing you, arrow up. Note if it sticks out perpendicular (axis convention wrong).',
  },
  {
    id: 'alpha-steps',
    matrix: ['IOS-ALPHA-01', 'AND-ALPHA-01'],
    title: 'Alpha: 0 / 20 / 50 / 80 / 100 % bands',
    fixture: 'alpha_steps.png',
    anchor: 'floor',
    settings: { widthMeters: 1.0, shapeMode: 'flat', alphaMode: 'auto', pivot: 'bottom-center', doubleSided: true },
    expect: 'Leftmost band invisible, then increasingly opaque green. No white/black rectangle behind the bands.',
  },
  {
    id: 'alpha-hole',
    matrix: ['IOS-ALPHA-01', 'AND-ALPHA-01'],
    title: 'Alpha: ring with transparent inner hole (MASK)',
    fixture: 'ring_inner_hole.png',
    anchor: 'floor',
    settings: { widthMeters: 0.5, shapeMode: 'flat', alphaMode: 'auto', pivot: 'bottom-center' },
    expect: 'Environment visible through the hole and around the ring.',
  },
  {
    id: 'alpha-fringe',
    matrix: ['IOS-ALPHA-01', 'AND-ALPHA-01'],
    title: 'Alpha: antialiased disc with near-invisible dark fringe (halo trap)',
    fixture: 'aa_disc_dark_fringe.png',
    anchor: 'floor',
    settings: { widthMeters: 0.5, shapeMode: 'flat', alphaMode: 'auto', pivot: 'bottom-center' },
    expect: 'Smooth white disc edge. A visible dark ring = premultiplication/filtering defect.',
  },
  {
    id: 'link-cta',
    matrix: ['AND-LINK-01'],
    title: 'Primary CTA: Scene Viewer link / Quick Look banner',
    fixture: 'logo_transparent_border.png',
    anchor: 'floor',
    settings: { widthMeters: 0.5, shapeMode: 'flat', alphaMode: 'auto', pivot: 'bottom-center' },
    expect: 'Native CTA visible; tapping opens https://example.com/?p0=cta (Quick Look: banner tap is handled by this page).',
    link: 'https://example.com/?p0=cta',
  },
];

const FIX = join(ROOT, 'tests', 'fixtures');
const OUT = join(ROOT, 'out', 'p0');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function rgbaOf(bytes: Uint8Array) {
  const info = readImageInfo(bytes);
  if (info.mime !== 'image/png') return null;
  const png = PNG.sync.read(Buffer.from(bytes));
  return analyzeAlpha(new Uint8Array(png.data), png.width, png.height);
}

rmSync(OUT, { recursive: true, force: true });
for (const d of ['glb', 'usdz', 'images']) mkdirSync(join(OUT, d), { recursive: true });

const results = [];
for (const c of CASES) {
  const src = new Uint8Array(readFileSync(join(FIX, 'images', c.fixture)));
  const settings = ImageToArSettings.parse(c.settings);
  const alphaMode = resolveAlphaMode(settings.alphaMode, rgbaOf(src));
  const glb = buildImagePlaneGlb({ image: src, settings, alphaMode, name: c.id });
  writeFileSync(join(OUT, 'glb', `${c.id}.glb`), glb.glb);
  copyFileSync(join(FIX, 'images', c.fixture), join(OUT, 'images', c.fixture));

  const args = [
    'run', ...SANDBOX, ...mount(FIX, '/fixtures'), ...mount(join(OUT, 'usdz'), '/out', false),
    IMAGE, 'python', '-m', 'usd_processor', 'image-plane',
    '--image', `/fixtures/images/${c.fixture}`, '--out', `/out/${c.id}.usdz`,
    '--width-m', String(settings.widthMeters), '--alpha-mode', alphaMode, '--alpha-cutoff', String(settings.alphaCutoff),
    '--pivot', settings.pivot, '--orientation', settings.orientation, '--anchor', c.anchor,
    ...(settings.doubleSided ? ['--double-sided'] : []),
    ...(c.anchor === 'image' ? ['--tracking-image', `/fixtures/images/${T}`, '--tracking-width-m', '0.2'] : []),
  ];
  const r = docker(args, { capture: true });
  if (r.status !== 0) throw new Error(`usd conversion failed for ${c.id}: ${r.stdout}`);
  const usd = JSON.parse(r.stdout);
  if (Math.abs(usd.height_m - glb.heightMeters) > 1e-9) throw new Error(`GLB/USDZ height mismatch for ${c.id}`);
  results.push({
    ...c,
    alphaMode,
    widthMeters: glb.widthMeters,
    heightMeters: glb.heightMeters,
    glb: { path: `glb/${c.id}.glb`, sha256: sha(glb.glb), bytes: glb.glb.length },
    usdz: { path: `usdz/${c.id}.usdz`, sha256: usd.sha256, validationErrors: usd.validation_errors, validationWarnings: usd.validation_warnings },
  });
  console.log(`${c.id.padEnd(14)} ${alphaMode.padEnd(7)} ${glb.widthMeters}x${glb.heightMeters} m  glb ${sha(glb.glb).slice(0, 10)}  usdz ${String(usd.sha256).slice(0, 10)}`);
}
copyFileSync(join(FIX, 'images', T), join(OUT, 'images', T));
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ generatedBy: 'scripts/build-p0.ts', cases: results }, null, 2) + '\n');

// Workers Static Assets headers: correct MIME types for native viewers.
writeFileSync(
  join(OUT, '_headers'),
  ['/usdz/*', '  Content-Type: model/vnd.usdz+zip', '/glb/*', '  Content-Type: model/gltf-binary', '  Access-Control-Allow-Origin: *', '/*', "  Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'", '  X-Content-Type-Options: nosniff', ''].join('\n'),
);

// ---- device-lab page
const base = process.env.P0_BASE_URL?.replace(/\/+$/, '');
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const rows = results
  .map((c) => {
    let android = '<em>needs P0_BASE_URL</em>';
    let ios = '<em>needs P0_BASE_URL</em>';
    if (base) {
      ios = `<a rel="ar" data-cta="${c.link ? esc(c.link) : ''}" href="${esc(
        buildQuickLookHref({ usdzUrl: `${base}/${c.usdz.path}`, ...(c.link ? { callToAction: 'Open link' } : {}), canonicalWebPageUrl: `${base}/` }),
      )}"><img src="images/${esc(c.fixture)}" alt="Open ${esc(c.id)} in AR Quick Look" width="120"></a>`;
      android =
        c.anchor === 'image'
          ? '<a class="btn" href="webxr/">Open WebXR image probe</a> <small>(experimental; never Scene Viewer)</small>'
          : `<a class="btn" href="${esc(
              buildSceneViewerIntent({
                placement: c.anchor,
                fileUrl: `${base}/${c.glb.path}`,
                browserFallbackUrl: `${base}/#${c.id}`,
                title: c.id,
                ...(c.link ? { link: c.link } : {}),
              }),
            )}">Open in Scene Viewer</a>`;
    }
    return `<section id="${esc(c.id)}"><h2>${esc(c.title)}</h2>
<p class="meta">${esc(c.matrix.join(', '))} · anchor <b>${c.anchor}</b> · ${c.widthMeters}×${c.heightMeters} m · alpha <b>${c.alphaMode}</b></p>
<p><b>Expect:</b> ${esc(c.expect)}</p>
<div class="launch"><div><h3>iOS · Quick Look</h3>${ios}</div><div><h3>Android</h3>${android}</div></div>
<p class="files"><a href="${c.glb.path}" download>GLB</a> <code>${c.glb.sha256.slice(0, 16)}</code> · <a href="${c.usdz.path}" download>USDZ</a> <code>${String(c.usdz.sha256).slice(0, 16)}</code></p></section>`;
  })
  .join('\n');

writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AR Creator P0 Device Lab</title><link rel="icon" href="data:,"><style>
:root{--ui-bg:#f7f8fa;--ui-surface:#fff;--ui-text:#17202a;--ui-text-secondary:#596676;--ui-border:#dce2e8;--ui-accent:#215cc5;--ui-warning:#95610b}
body{margin:0;background:var(--ui-bg);color:var(--ui-text);font:16px/1.5 system-ui,sans-serif}main{max-width:860px;margin:0 auto;padding:16px}
section{background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:10px;padding:16px;margin:16px 0}h2{font-size:1.1rem;margin:0 0 4px}h3{font-size:.9rem;margin:0 0 8px;color:var(--ui-text-secondary)}
.meta,.files{color:var(--ui-text-secondary);font-size:.85rem}.launch{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:560px){.launch{grid-template-columns:1fr}}
.btn{display:inline-block;min-height:44px;line-height:44px;padding:0 16px;background:var(--ui-accent);color:#fff;border-radius:6px;text-decoration:none}
.warn{border-left:4px solid var(--ui-warning);padding:8px 12px;background:#fff8e6}code{font-size:.8rem}
</style></head><body><main><h1>P0 Device Lab</h1>
<p class="warn">Test harness only. Results count only when recorded in <code>TESTING.md</code> with device, OS, browser/viewer versions and asset checksums. Print <a href="images/${T}">the tracking target</a> at exactly <b>20.0 cm</b> wide for image tests.</p>
${rows}
<script src="lab.js"></script></main></body></html>\n`,
);
// Quick Look banner tap → open the CTA (message event on the <a rel="ar"> element). No inline script (CSP).
writeFileSync(
  join(OUT, 'lab.js'),
  `document.querySelectorAll('a[rel="ar"][data-cta]').forEach(function (a) {
  var url = a.getAttribute('data-cta');
  if (!url || url.indexOf('https://') !== 0) return;
  a.addEventListener('message', function (e) { if (e.data === '_apple_ar_quicklook_button_tapped') window.location.href = url; }, false);
});
`,
);
// Android image runtime probe (AND-IMG-01) → out/p0/webxr/
await viteBuild({ configFile: join(ROOT, 'apps', 'p0-webxr-probe', 'vite.config.ts'), logLevel: 'warn' });
console.log(`\nwrote ${OUT}${base ? '' : '  (set P0_BASE_URL to generate launch links)'}`);

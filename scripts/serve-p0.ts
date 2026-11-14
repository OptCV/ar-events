/**
 * Local static server for out/p0 that applies out/p0/_headers the way Workers Static Assets does
 * (path-glob blocks, later matches add headers). For desktop smoke tests only — phones need HTTPS
 * (or `adb reverse` to localhost) for WebXR.
 *   node --experimental-strip-types scripts/serve-p0.ts [port]
 */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { ROOT } from './usd.ts';

const DIR = join(ROOT, 'out', 'p0');
const port = Number(process.argv[2] ?? 8787);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function parseHeaders(): { pattern: RegExp; headers: [string, string][] }[] {
  const rules: { pattern: RegExp; headers: [string, string][] }[] = [];
  for (const line of readFileSync(join(DIR, '_headers'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (!line.startsWith(' ')) {
      const rx = '^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      rules.push({ pattern: new RegExp(rx), headers: [] });
    } else {
      const i = line.indexOf(':');
      rules.at(-1)!.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}
const rules = parseHeaders();

createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = normalize(join(DIR, urlPath));
  if (!file.startsWith(DIR + sep) && file !== DIR) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    const body = readFileSync(file);
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    for (const r of rules) if (r.pattern.test(urlPath)) for (const [k, v] of r.headers) res.setHeader(k, v);
    res.writeHead(200).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`serving ${DIR} on http://localhost:${port}`));

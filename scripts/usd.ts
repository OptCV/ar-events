/**
 * Docker wrapper for services/usd-processor (cross-platform; argv arrays only, no shell).
 *   node --experimental-strip-types scripts/usd.ts build
 *   node --experimental-strip-types scripts/usd.ts test
 *   node --experimental-strip-types scripts/usd.ts serve [--detach]   # runtime image on http://127.0.0.1:8790 (local dev/tests)
 *   node --experimental-strip-types scripts/usd.ts stop
 * Containers run with --network none, a read-only root FS, and CPU/memory/pids limits (SECURITY.md).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const IMAGE = 'ar-creator/usd-processor:dev';
/** The image Cloudflare Containers run (Dockerfile `runtime` stage, the default target). */
export const RUNTIME_IMAGE = 'ar-creator/usd-processor:runtime';
export const SERVE_NAME = 'ar-creator-usd';
export const SERVE_PORT = 8790;
const SVC = join(ROOT, 'services', 'usd-processor');

export const SANDBOX = ['--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=512m', '--tmpfs', '/var/tmp:rw,size=512m', // OpenUSD crate writer stages in /var/tmp
   '--memory', '1g', '--cpus', '2', '--pids-limit', '128'];

export function docker(args: string[], opts: { capture?: boolean } = {}) {
  const r = spawnSync('docker', args, { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}

export function mount(host: string, container: string, ro = true) {
  return ['-v', `${host}:${container}${ro ? ':ro' : ''}`];
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'build') {
    process.exit(docker(['build', '--target', 'test', '-t', IMAGE, SVC]).status ?? 1);
  } else if (cmd === 'test') {
    const r = docker([
      'run', ...SANDBOX, '-w', '/app', '-e', 'PYTHONDONTWRITEBYTECODE=1',
      ...mount(join(SVC, 'usd_processor'), '/app/usd_processor'),
      ...mount(join(SVC, 'tests'), '/app/tests'),
      ...mount(join(SVC, 'fonts'), '/app/fonts'),
      ...mount(join(ROOT, 'tests', 'fixtures'), '/fixtures'),
      IMAGE, 'python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests',
    ]);
    process.exit(r.status ?? 1);
  } else if (cmd === 'serve') {
    // Same image as the Cloudflare Container. Locally it needs a published loopback port, so it cannot use
    // --network none; it is bound to 127.0.0.1 only and keeps the read-only root FS and resource limits.
    const b = docker(['build', '-q', '-t', RUNTIME_IMAGE, SVC]);
    if (b.status) process.exit(b.status);
    docker(['rm', '-f', SERVE_NAME], { capture: true });
    const detach = process.argv.includes('--detach');
    const r = docker([
      'run', ...(detach ? ['-d'] : []), '--rm', '--name', SERVE_NAME, '--read-only', '--tmpfs', '/tmp:rw,size=512m', '--tmpfs', '/var/tmp:rw,size=512m',
      '--memory', '1g', '--cpus', '2', '--pids-limit', '128', '-p', `127.0.0.1:${SERVE_PORT}:8080`, RUNTIME_IMAGE,
    ]);
    process.exit(r.status ?? 1);
  } else if (cmd === 'fixtures-webp') {
    // WebP fixtures for ADR-025, generated with the pinned Pillow/libwebp in the sandbox (no network).
    const out = join(ROOT, 'tests', 'fixtures', 'normalize');
    const r = docker([
      'run', ...SANDBOX, '-w', '/app',
      ...mount(join(SVC, 'tools'), '/app/tools'),
      ...mount(join(ROOT, 'tests', 'fixtures'), '/fixtures'),
      ...mount(out, '/out', false),
      IMAGE, 'python', 'tools/make_webp_fixtures.py', '/out',
    ]);
    process.exit(r.status ?? 1);
  } else if (cmd === 'stop') {
    process.exit(docker(['rm', '-f', SERVE_NAME]).status ?? 1);
  } else {
    console.error('usage: usd.ts build|test|serve [--detach]|stop');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

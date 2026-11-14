/**
 * Docker wrapper for services/usd-processor (cross-platform; argv arrays only, no shell).
 *   node --experimental-strip-types scripts/usd.ts build
 *   node --experimental-strip-types scripts/usd.ts test
 * Containers run with --network none, a read-only root FS, and CPU/memory/pids limits (SECURITY.md).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const IMAGE = 'ar-creator/usd-processor:dev';
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
    process.exit(docker(['build', '-t', IMAGE, SVC]).status ?? 1);
  } else if (cmd === 'test') {
    const r = docker([
      'run', ...SANDBOX, '-w', '/app', '-e', 'PYTHONDONTWRITEBYTECODE=1',
      ...mount(join(SVC, 'usd_processor'), '/app/usd_processor'),
      ...mount(join(SVC, 'tests'), '/app/tests'),
      ...mount(join(ROOT, 'tests', 'fixtures'), '/fixtures'),
      IMAGE, 'python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests',
    ]);
    process.exit(r.status ?? 1);
  } else {
    console.error('usage: usd.ts build|test');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

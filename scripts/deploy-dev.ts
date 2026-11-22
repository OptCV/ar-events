/**
 * Build and deploy the ISOLATED remote-test Worker `ar-creator-dev` (ADR-020). Never deploys production.
 *
 *   npm run deploy:dev -- --subdomain <workers.dev subdomain> --dry-run   # validate everything, upload nothing
 *   npm run deploy:dev -- --subdomain <workers.dev subdomain>             # upload after typed confirmation
 *
 * Guards (all must pass before any upload):
 *   - built config is the `dev` environment: name ar-creator-dev, ONLY the development Hyperdrive binding,
 *     the production Hyperdrive ID appears nowhere, APP_ENV=production, sign-up off, https BETTER_AUTH_URL
 *   - the only R2 binding is the development bucket (ar-creator-assets-dev)
 *   - local secret files (.dev.vars) are removed from the output, and NO value from apps/web/.dev.vars or the
 *     repo-root .env appears anywhere in the output (the Cloudflare Vite plugin copies .dev.vars for `vite preview`)
 *   - the operator types the Worker name to confirm
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './usd.ts';

const WORKER = 'ar-creator-dev';
const DEV_HYPERDRIVE = 'f7b30d814f184296bb44518058778789';
const PROD_HYPERDRIVE = '8de2df3d333b4a1b9b07c18fbdd49d18';
const DEV_BUCKET = 'ar-creator-assets-dev';
const WEB = join(ROOT, 'apps', 'web');
const DIST = join(WEB, 'dist');

function fail(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const subdomain = argv[argv.indexOf('--subdomain') + 1];
if (argv.indexOf('--subdomain') < 0 || !subdomain || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain)) {
  fail('usage: npm run deploy:dev -- --subdomain <your workers.dev subdomain> [--dry-run]');
}
const origin = `https://${WORKER}.${subdomain}.workers.dev`;

// 1. Clean build of the `dev` environment.
rmSync(DIST, { recursive: true, force: true });
const build = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: WEB, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, CLOUDFLARE_ENV: 'dev' } });
if (build.status !== 0) fail('build failed');

// 2. Validate the generated Worker config and set the real origin.
const workerDir = readdirSync(DIST).find((d) => d !== 'client' && existsSync(join(DIST, d, 'wrangler.json')));
if (!workerDir) fail('no Worker output found');
const cfgPath = join(DIST, workerDir, 'wrangler.json');
const cfgText = readFileSync(cfgPath, 'utf8');
const cfg = JSON.parse(cfgText) as { name: string; hyperdrive: { binding: string; id: string }[]; r2_buckets?: { binding: string; bucket_name: string }[]; vars: Record<string, string> };
if (cfg.name !== WORKER) fail(`built Worker is "${cfg.name}", expected "${WORKER}"`);
if (cfgText.includes(PROD_HYPERDRIVE)) fail('production Hyperdrive ID found in the built config');
if (JSON.stringify(cfg.hyperdrive) !== JSON.stringify([{ binding: 'HYPERDRIVE', id: DEV_HYPERDRIVE }])) fail('Hyperdrive binding is not exactly the development config');
if (JSON.stringify((cfg.r2_buckets ?? []).map((b) => ({ binding: b.binding, bucket_name: b.bucket_name }))) !== JSON.stringify([{ binding: 'ASSETS_BUCKET', bucket_name: DEV_BUCKET }])) {
  fail('R2 binding is not exactly the development bucket');
}
if (cfg.vars.APP_ENV !== 'production' || cfg.vars.AUTH_SIGNUP_ENABLED !== 'false') fail('dev Worker must run production-strict with sign-up off');
if (!cfg.vars.BETTER_AUTH_URL?.includes('__WORKERS_SUBDOMAIN__')) fail('unexpected BETTER_AUTH_URL template');
cfg.vars.BETTER_AUTH_URL = origin;
writeFileSync(cfgPath, JSON.stringify(cfg));

// 3. Strip local secret files and prove no local secret VALUE is in the output.
const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(DIST);
for (const f of files.filter((p) => /[\\/]\.dev\.vars|[\\/]\.env/.test(p))) rmSync(f);
const secretValues: string[] = [];
for (const file of [join(WEB, '.dev.vars'), join(ROOT, '.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^[A-Z0-9_]+=(.+)$/.exec(line);
    if (m && m[1]!.length >= 12 && !/^(development|production|dev-mailbox|resend|true|false)$/.test(m[1]!) && !m[1]!.startsWith('AR Creator <')) secretValues.push(m[1]!);
  }
}
files.length = 0;
walk(DIST);
for (const f of files) {
  const text = readFileSync(f, 'latin1');
  for (const v of secretValues) if (text.includes(v)) fail(`a local secret value was found in ${f}; refusing to deploy`);
}
console.log(`\n  Worker        ${cfg.name}\n  URL           ${origin}\n  Hyperdrive    ${DEV_HYPERDRIVE} (ar-creator-db-dev → Neon development, role ar_app)\n  R2 bucket     ${DEV_BUCKET}\n  APP_ENV       ${cfg.vars.APP_ENV}\n  sign-up       ${cfg.vars.AUTH_SIGNUP_ENABLED}\n  files         ${files.length} checked, 0 local secrets, no .dev.vars`);

// 4. Deploy (or dry-run) after typed confirmation.
if (!dryRun) {
  process.stdout.write(`\nType "${WORKER}" to upload this Worker: `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(String(d).trim());
    });
  });
  if (answer !== WORKER) fail('Confirmation did not match; nothing was uploaded.');
}
const args = ['wrangler', 'deploy', '--config', cfgPath, ...(dryRun ? ['--dry-run', '--outdir', join(DIST, '.dry-run')] : [])];
const r = spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) fail('wrangler deploy failed');
console.log(dryRun ? '\n✔ Dry run passed: nothing was uploaded.' : `\n✔ Deployed ${WORKER}. Next: npx wrangler secret put BETTER_AUTH_SECRET --name ${WORKER}`);

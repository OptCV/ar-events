// End-to-end spike verification in workerd (the Workers runtime) via `wrangler dev`.
// Postgres runs in Docker; Hyperdrive binding uses its documented local connection string.
// Prints a JSON report. Timings are LOCAL WALL-CLOCK, not Cloudflare CPU time.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const PG = { name: 'spike-auth-pg', image: 'postgres:17-alpine', port: 54329 };
const DB_URL = `postgres://spike:spike@127.0.0.1:${PG.port}/spike`;
const BASE = 'http://127.0.0.1:8799';
const results = [];
const check = (name, ok, detail = {}) => {
  results.push({ name, ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${Object.keys(detail).length ? '  ' + JSON.stringify(detail) : ''}`);
};
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => sh('docker', ['exec', PG.name, 'psql', '-U', 'spike', '-d', 'spike', '-tAc', `"${sql}"`]).stdout.trim();

let wrangler;
async function main() {
  sh('docker', ['rm', '-f', PG.name]);
  const run = sh('docker', ['run', '-d', '--name', PG.name, '-e', 'POSTGRES_USER=spike', '-e', 'POSTGRES_PASSWORD=spike', '-e', 'POSTGRES_DB=spike', '-p', `127.0.0.1:${PG.port}:5432`, PG.image]);
  if (run.status !== 0) throw new Error(run.stderr);
  for (let i = 0; i < 60; i++) {
    if (sh('docker', ['exec', PG.name, 'pg_isready', '-U', 'spike', '-d', 'spike', '-h', '127.0.0.1']).status === 0) break;
    await sleep(500);
  }
  await sleep(1000);
  const mig = sh('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, DATABASE_URL: DB_URL } });
  check('drizzle-kit migrate applies Better Auth schema', mig.status === 0, mig.status === 0 ? {} : { stderr: mig.stderr.slice(-400) });

  // Random per-run secret, local only (.dev.vars is gitignored).
  writeFileSync('.dev.vars', `BETTER_AUTH_SECRET=${randomBytes(32).toString('base64url')}\nTRUSTED_ORIGINS=${BASE}\n`);
  wrangler = spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', '8799', '--log-level', 'warn'], {
    shell: process.platform === 'win32',
    env: { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: DB_URL, WRANGLER_SEND_METRICS: 'false' },
  });
  let wlog = '';
  wrangler.stdout.on('data', (d) => (wlog += d));
  wrangler.stderr.on('data', (d) => (wlog += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/api/health`)).ok;
    } catch {}
    if (!up) await sleep(500);
  }
  check('wrangler dev (workerd) serves Hono app', up);
  if (!up) throw new Error(`wrangler did not start:\n${wlog.slice(-2000)}`);

  const json = { 'content-type': 'application/json', origin: BASE };
  const email = `spike-${Date.now()}@example.com`;
  const password = 'correct horse battery staple 42';
  const timed = async (path, init = {}) => {
    const t = performance.now();
    const res = await fetch(BASE + path, init);
    const body = await res.text();
    return { res, body, ms: Math.round(performance.now() - t), serverMs: Number(res.headers.get('x-spike-total-ms')) };
  };

  let r = await timed('/api/me');
  check('unauthenticated /api/me → 401', r.res.status === 401);

  r = await timed('/api/auth/sign-up/email', { method: 'POST', headers: json, body: JSON.stringify({ email, password, name: 'Spike' }) });
  check('sign-up/email → 200', r.res.status === 200, { status: r.res.status, wallMs: r.ms, serverMs: r.serverMs, ...(r.res.status !== 200 && { body: r.body.slice(0, 300) }) });

  r = await timed('/api/auth/sign-up/email', { method: 'POST', headers: json, body: JSON.stringify({ email, password, name: 'Dup' }) });
  check('duplicate sign-up rejected (4xx)', r.res.status >= 400 && r.res.status < 500, { status: r.res.status });

  r = await timed('/api/auth/sign-in/email', { method: 'POST', headers: { ...json, 'cf-connecting-ip': '203.0.113.10' }, body: JSON.stringify({ email, password: 'wrong password!!' }) });
  check('sign-in with wrong password → 401', r.res.status === 401, { status: r.res.status });

  r = await timed('/api/auth/sign-in/email', { method: 'POST', headers: { ...json, 'cf-connecting-ip': '203.0.113.11' }, body: JSON.stringify({ email, password }) });
  const setCookie = r.res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const attrs = setCookie.join(' | ');
  check('sign-in/email → 200 + session cookie', r.res.status === 200 && /session_token/.test(cookie), { status: r.res.status, wallMs: r.ms, serverMs: r.serverMs });
  check('session cookie is HttpOnly + SameSite=Lax', /HttpOnly/i.test(attrs) && /SameSite=Lax/i.test(attrs), { attrs: attrs.replace(/=[^;|]{12,}/g, '=<redacted>') });

  r = await timed('/api/me', { headers: { cookie } });
  check('authenticated /api/me → 200 with own email', r.res.status === 200 && JSON.parse(r.body).email === email, { status: r.res.status });

  // Cross-request isolation: per-request clients must never be reused (workerd throws on cross-request I/O).
  const many = await Promise.all(Array.from({ length: 12 }, () => fetch(`${BASE}/api/me`, { headers: { cookie } }).then((x) => x.status)));
  check('12 concurrent session lookups all 200 (no cross-request I/O errors)', many.every((s) => s === 200), { statuses: [...new Set(many)] });

  const stored = psql(`select password from account where provider_id='credential' limit 1`);
  check('password stored hashed (not plaintext)', stored.length > 40 && !stored.includes(password), { format: stored.replace(/[A-Za-z0-9+/=]{8,}/g, '…').slice(0, 40) });

  r = await timed('/api/auth/sign-out', { method: 'POST', headers: { ...json, cookie }, body: '{}' });
  check('sign-out → 200', r.res.status === 200, { status: r.res.status });
  r = await timed('/api/me', { headers: { cookie } });
  check('/api/me after sign-out → 401 (session revoked server-side)', r.res.status === 401, { status: r.res.status });

  // Rate limit: same client IP hammering sign-in must eventually get 429, counters stored in Postgres.
  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const x = await fetch(`${BASE}/api/auth/sign-in/email`, { method: 'POST', headers: { ...json, 'cf-connecting-ip': '198.51.100.7' }, body: JSON.stringify({ email, password: 'nope nope nope' }) });
    statuses.push(x.status);
  }
  const rlRows = Number(psql('select count(*) from rate_limit'));
  check('sign-in rate limited per CF-Connecting-IP (429) with DB storage', statuses.includes(429) && rlRows > 0, { statuses, rateLimitRows: rlRows });
  const otherIp = await fetch(`${BASE}/api/auth/sign-in/email`, { method: 'POST', headers: { ...json, 'cf-connecting-ip': '198.51.100.8' }, body: JSON.stringify({ email, password: 'nope nope nope' }) });
  check('a different client IP is not blocked by that limit', otherIp.status === 401, { status: otherIp.status });

  const errs = wlog.split('\n').filter((l) => /error|exception|cannot perform i\/o/i.test(l));
  check('no runtime errors in workerd log', errs.length === 0, errs.length ? { errors: errs.slice(0, 5) } : {});
}

try {
  await main();
} catch (e) {
  check('spike run', false, { error: String(e).slice(0, 1500) });
} finally {
  if (wrangler) {
    if (process.platform === 'win32') sh('taskkill', ['/pid', String(wrangler.pid), '/T', '/F']);
    else wrangler.kill('SIGTERM');
  }
  sh('docker', ['rm', '-f', PG.name]);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  writeFileSync('verify-result.json', JSON.stringify({ date: new Date().toISOString(), node: process.version, results }, null, 2) + '\n');
  process.exit(failed ? 1 : 0);
}

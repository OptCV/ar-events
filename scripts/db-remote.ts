/**
 * Guarded operations against a REMOTE (Neon) database. See infra/db/NEON.md and ADR-018.
 *
 *   npm run db:remote -- status  --env development   # read-only: target identity, marker, pending migrations
 *   npm run db:remote -- migrate --env development   # apply migrations as ar_migrator (+ runtime grants)
 *   npm run db:remote -- verify  --env development   # runtime-role checks as ar_app (all writes rolled back)
 *
 * Connection strings are read from a HIDDEN prompt (nothing echoed, nothing in shell history), or from
 * AR_REMOTE_MIGRATOR_URL / AR_REMOTE_APP_URL if you inject them with a secret manager. They are never
 * printed, written to disk or passed on a command line. Production requires --approved plus a typed confirmation.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { redact } from '../packages/db/src/redact.ts';
import { ROOT } from './usd.ts';

type Env = 'development' | 'production';
const DB = join(ROOT, 'packages', 'db');
const JOURNAL = JSON.parse(readFileSync(join(DB, 'migrations', 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };

function fail(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function args() {
  const [cmd, ...rest] = process.argv.slice(2);
  const env = rest[rest.indexOf('--env') + 1] as Env | undefined;
  if (!cmd || !['status', 'migrate', 'verify'].includes(cmd)) fail('usage: db:remote -- <status|migrate|verify> --env <development|production> [--approved]');
  if (rest.indexOf('--env') < 0 || (env !== 'development' && env !== 'production')) fail('--env development|production is required');
  return { cmd: cmd as 'status' | 'migrate' | 'verify', env, approved: rest.includes('--approved') };
}

/** Read a line without echoing it (raw TTY). */
async function hidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    fail('No interactive terminal for a hidden prompt. Use PowerShell/Windows Terminal, or inject the URL via the documented env var.');
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function typed(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(String(d).trim());
    });
  });
}

async function connectionString(kind: 'migrator' | 'app'): Promise<string> {
  const fromEnv = kind === 'migrator' ? process.env.AR_REMOTE_MIGRATOR_URL : process.env.AR_REMOTE_APP_URL;
  const url = fromEnv || (await hidden(`Paste the ${kind === 'migrator' ? 'ar_migrator' : 'ar_app'} DIRECT connection string (input hidden): `));
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail('That is not a valid connection URL.');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) fail('Expected a postgres:// URL.');
  const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (!local && !/^(require|verify-ca|verify-full)$/.test(parsed.searchParams.get('sslmode') ?? '')) fail('Remote connections must include sslmode=require (or verify-full).');
  if (parsed.hostname.includes('-pooler')) fail('Use the DIRECT endpoint (no "-pooler"): migrations and Hyperdrive need session-level connections.');
  return url;
}

interface Target {
  endpoint: string;
  database: string;
  user: string;
  marker: string | null;
  tls: boolean;
  applied: number[];
}

async function inspect(c: Client, url: string): Promise<Target> {
  const u = new URL(url);
  const r = await c.query<{ db: string; usr: string; marker: string | null }>("SELECT current_database() AS db, current_user AS usr, current_setting('ar.environment', true) AS marker");
  const tls = (await c.query<{ ssl: boolean }>('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0]?.ssl ?? false;
  let applied: number[] = [];
  try {
    applied = (await c.query<{ created_at: string }>('SELECT created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows.map((x) => Number(x.created_at));
  } catch {
    applied = [];
  }
  return { endpoint: u.hostname.split('.')[0] ?? '?', database: r.rows[0]!.db, user: r.rows[0]!.usr, marker: r.rows[0]!.marker, tls, applied };
}

function report(t: Target) {
  const pending = JOURNAL.entries.filter((e) => !t.applied.includes(e.when)).map((e) => e.tag);
  console.log(`\n  endpoint     ${t.endpoint}\n  database     ${t.database}\n  role         ${t.user}\n  ar.environment ${t.marker ?? '(not set)'}\n  TLS          ${t.tls}`);
  console.log(`  migrations   ${t.applied.length}/${JOURNAL.entries.length} applied${pending.length ? `; pending: ${pending.join(', ')}` : ''}`);
  return pending;
}

async function main() {
  const { cmd, env, approved } = args();
  if (env === 'production' && cmd === 'migrate' && !approved) fail('Production migrations require --approved (owner sign-off recorded in PROGRESS.md).');

  if (cmd === 'verify') {
    const url = await connectionString('app');
    // Child process env only — never argv, never printed.
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.remote.config.ts'], {
      cwd: DB,
      stdio: 'inherit',
      env: { ...process.env, AR_REMOTE_APP_URL: url, AR_REMOTE_EXPECT_ENV: env },
    });
    process.exit(r.status ?? 1);
  }

  const url = await connectionString('migrator');
  const c = new Client({ connectionString: url, application_name: 'ar-creator-migrate', connectionTimeoutMillis: 15_000 });
  c.on('error', () => undefined);
  try {
    await c.connect();
    const t = await inspect(c, url);
    const pending = report(t);
    if (t.marker !== env) fail(`Refusing: ar.environment is "${t.marker ?? 'unset'}", expected "${env}". Set the marker on the correct branch (infra/db/NEON.md step 3).`);
    if (!t.tls && !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) fail('Refusing: connection is not using TLS.');
    if (cmd === 'status') return;

    if (t.user !== 'ar_migrator') fail(`Refusing: migrations must run as ar_migrator (connected as ${t.user}) so ar_migrator owns the schema.`);
    if (pending.length === 0) console.log('\n  Nothing to apply; re-applying runtime grants (idempotent).');
    const answer = await typed(`\nType "${env}" to apply ${pending.length} migration(s) to endpoint ${t.endpoint}: `);
    if (answer !== env) fail('Confirmation did not match; nothing was changed.');
    await migrate(drizzle(c), { migrationsFolder: join(DB, 'migrations') });
    await c.query(readFileSync(join(DB, 'sql', '02-app-grants.sql'), 'utf8'));
    report(await inspect(c, url));
    console.log('\n✔ Migrations and runtime grants applied.');
  } catch (e) {
    const err = e as { code?: string; message?: string };
    fail(`Database error${err.code ? ` [${err.code}]` : ''}: ${redact(String(err.message ?? e))}`);
  } finally {
    await c.end().catch(() => undefined);
  }
}

await main();

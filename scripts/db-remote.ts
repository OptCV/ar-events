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
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { redact } from '../packages/db/src/redact.ts';
import { clientTls, type ClientTls } from '../packages/db/src/tls.ts';
import { readEnvironmentMarker, type EnvironmentMarker } from '../packages/db/src/environment.ts';
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
  if (!cmd || !['status', 'migrate', 'verify', 'create-roles', 'remote-auth-test'].includes(cmd)) {
    fail('usage: db:remote -- <create-roles|status|migrate|verify|remote-auth-test> --env <development|production> [--host <hostname> [--port 5432] [--database neondb]] [--approved]');
  }
  if (rest.indexOf('--env') < 0 || (env !== 'development' && env !== 'production')) fail('--env development|production is required');
  const flag = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const host = flag('--host');
  if (host !== undefined && !/^[a-z0-9.-]+$/i.test(host)) fail('--host must be a bare hostname, e.g. ep-xxx.c-16.us-east-1.aws.neon.tech (no user, password or path).');
  CONNECT = { host, port: flag('--port') ?? '5432', database: flag('--database') ?? 'neondb' };
  return { cmd: cmd as 'status' | 'migrate' | 'verify' | 'create-roles' | 'remote-auth-test', env, approved: rest.includes('--approved'), baseUrl: flag('--base-url') };
}

/** Optional `--host` mode: build the URL from non-secret parts and ask only for the password (hidden). */
let CONNECT: { host: string | undefined; port: string; database: string } = { host: undefined, port: '5432', database: 'neondb' };

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

async function connectionString(kind: 'owner' | 'migrator' | 'app'): Promise<string> {
  const ENV = { owner: 'AR_REMOTE_OWNER_URL', migrator: 'AR_REMOTE_MIGRATOR_URL', app: 'AR_REMOTE_APP_URL' } as const;
  const ROLE = { owner: 'neondb_owner (database owner)', migrator: 'ar_migrator', app: 'ar_app' } as const;
  const USER = { owner: 'neondb_owner', migrator: 'ar_migrator', app: 'ar_app' } as const;
  const fromEnv = process.env[ENV[kind]];
  let url: string;
  if (fromEnv) url = fromEnv;
  else if (CONNECT.host) {
    const pw = await hidden(`Password for ${USER[kind]} on ${CONNECT.host} (input hidden): `);
    if (!pw) fail('No password entered; nothing was changed.');
    const local = ['localhost', '127.0.0.1'].includes(CONNECT.host);
    // encodeURIComponent: symbols such as @ : / # ? % in passwords must be escaped inside a URL.
    url = `postgres://${USER[kind]}:${encodeURIComponent(pw)}@${CONNECT.host}:${CONNECT.port}/${encodeURIComponent(CONNECT.database)}${local ? '' : '?sslmode=verify-full'}`;
  } else {
    url = await hidden(`Paste the ${ROLE[kind]} DIRECT connection string (input hidden): `);
  }
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
  // node-postgres already treats require/verify-ca as verify-full (certificate + hostname checked); make that explicit
  // so behaviour does not weaken when pg v9 adopts libpq semantics.
  if (!local) parsed.searchParams.set('sslmode', 'verify-full');
  return local ? url : parsed.toString();
}

interface Target {
  endpoint: string;
  database: string;
  user: string;
  marker: EnvironmentMarker;
  tls: ClientTls;
  applied: number[];
}

const isLocal = (url: string) => ['localhost', '127.0.0.1'].includes(new URL(url).hostname);
/** Remote targets must have an encrypted, certificate-verified client connection. */
const tlsOk = (t: Target, url: string) => isLocal(url) || (t.tls.encrypted && t.tls.verified);

async function inspect(c: Client, url: string): Promise<Target> {
  const u = new URL(url);
  const r = await c.query<{ db: string; usr: string }>('SELECT current_database() AS db, current_user AS usr');
  const marker = await readEnvironmentMarker(c);
  const tls = clientTls(c);
  let applied: number[] = [];
  try {
    applied = (await c.query<{ created_at: string }>('SELECT created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows.map((x) => Number(x.created_at));
  } catch {
    applied = [];
  }
  return { endpoint: u.hostname.split('.')[0] ?? '?', database: r.rows[0]!.db, user: r.rows[0]!.usr, marker, tls, applied };
}

function report(t: Target) {
  const pending = JOURNAL.entries.filter((e) => !t.applied.includes(e.when)).map((e) => e.tag);
  const tls = t.tls.encrypted ? `encrypted (${t.tls.protocol ?? 'TLS'}), certificate ${t.tls.verified ? 'verified' : 'NOT verified'}` : 'not encrypted';
  console.log(`\n  endpoint     ${t.endpoint}\n  database     ${t.database}\n  role         ${t.user}\n  ar.environment ${t.marker ?? '(not set)'}\n  TLS          ${tls}`);
  console.log(`  migrations   ${t.applied.length}/${JOURNAL.entries.length} applied${pending.length ? `; pending: ${pending.join(', ')}` : ''}`);
  return pending;
}

/** Neon requires >= 60 bits of entropy; we require more, with a character mix, and no quotes/backslashes. */
function passwordProblem(pw: string): string | null {
  if (pw.length < 24) return 'use at least 24 characters (generate it in your password manager)';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) return 'mix lowercase, uppercase, digits and symbols';
  if (/['"\\\s]/.test(pw)) return 'avoid quotes, backslashes and whitespace';
  return null;
}

async function newPassword(role: 'ar_migrator' | 'ar_app'): Promise<string> {
  const fromEnv = process.env[role === 'ar_migrator' ? 'AR_NEW_MIGRATOR_PASSWORD' : 'AR_NEW_APP_PASSWORD'];
  if (fromEnv) {
    const p = passwordProblem(fromEnv);
    if (p) fail(`${role} password: ${p}`);
    return fromEnv;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await hidden(`New password for ${role} (from your password manager, input hidden): `);
    const problem = passwordProblem(a);
    if (problem) {
      console.error(`  ✖ ${problem}`);
      continue;
    }
    const b = await hidden(`Repeat the ${role} password (input hidden): `);
    if (a === b) return a;
    console.error('  ✖ passwords did not match');
  }
  fail('No valid password entered; nothing was changed.');
}

/**
 * Create the restricted roles with SQL (Neon: Console/API/CLI roles inherit neon_superuser, SQL roles do not).
 * Passwords are entered hidden, sent once inside a transaction, never printed or stored. The statement text can
 * reach pg_stat_statements, so it is reset afterwards when available.
 */
async function createRoles(env: Env) {
  const url = await connectionString('owner');
  const c = new Client({ connectionString: url, application_name: 'ar-creator-create-roles', connectionTimeoutMillis: 15_000 });
  c.on('error', () => undefined);
  try {
    await c.connect();
    const t = await inspect(c, url);
    report(t);
    if (t.marker !== null && t.marker !== env) fail(`Refusing: ar.environment is "${t.marker}", expected "${env}".`);
    if (t.marker === null) console.log(`\n  ar.environment is not set yet; you will confirm the endpoint instead (marker is set in the next step).`);
    if (!tlsOk(t, url)) fail('Refusing: the connection is not encrypted with a verified certificate.');
    const existing = (await c.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname IN ('ar_migrator', 'ar_app')")).rows.map((r) => r.rolname);
    if (existing.length) fail(`Refusing: role(s) already exist: ${existing.join(', ')}. Nothing was changed. (Drop or rotate them deliberately; this command only creates.)`);

    const migratorPw = await newPassword('ar_migrator');
    const appPw = await newPassword('ar_app');
    if (migratorPw === appPw) fail('Use different passwords for ar_migrator and ar_app; nothing was changed.');
    const answer = await typed(`\nType the endpoint ID "${t.endpoint}" to create ar_migrator and ar_app on it: `);
    if (answer !== t.endpoint) fail('Confirmation did not match; nothing was changed.');

    const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT';
    await c.query('BEGIN');
    try {
      // Utility statements cannot take bind parameters; passwords were validated to contain no quotes/backslashes.
      await c.query(`CREATE ROLE ar_migrator WITH ${attrs} PASSWORD '${migratorPw}'`);
      await c.query(`CREATE ROLE ar_app WITH ${attrs} PASSWORD '${appPw}'`);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
    await c.query('SELECT pg_stat_statements_reset()').then(
      () => console.log('  pg_stat_statements reset (role statements cleared from statistics).'),
      () => console.log('  pg_stat_statements not available to this role; nothing to clear.'),
    );

    const r = await c.query<{ rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean; rolreplication: boolean; member_of: string[] }>(
      `SELECT r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication,
              coalesce(array_agg(g.rolname::text) FILTER (WHERE g.rolname IS NOT NULL), '{}'::text[]) AS member_of
       FROM pg_roles r LEFT JOIN pg_auth_members m ON m.member = r.oid LEFT JOIN pg_roles g ON g.oid = m.roleid
       WHERE r.rolname IN ('ar_migrator', 'ar_app') GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1`,
    );
    for (const row of r.rows) {
      const elevated = row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolbypassrls || row.rolreplication || row.member_of.length > 0;
      console.log(`  ${row.rolname.padEnd(12)} superuser=${row.rolsuper} createdb=${row.rolcreatedb} createrole=${row.rolcreaterole} bypassrls=${row.rolbypassrls} member_of=[${row.member_of.join(', ')}]`);
      if (elevated) fail(`${row.rolname} has elevated privileges; investigate before continuing.`);
    }
    console.log('\n✔ Roles created without elevated privileges. Store the passwords only in your password manager.');
  } catch (e) {
    const err = e as { code?: string; message?: string };
    fail(`Database error${err.code ? ` [${err.code}]` : ''}: ${redact(String(err.message ?? e))}`);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/**
 * Remote authentication test against the ISOLATED dev Worker (ADR-020), development database only.
 * Seeds one temporary, pre-verified user as ar_app (password random, in memory only, hashed with Better Auth's
 * own hashPassword), runs the Playwright `remote` suite, then ALWAYS deletes the user (cascade: sessions, accounts).
 */
async function remoteAuthTest(env: Env, baseUrl: string | undefined) {
  if (env !== 'development') fail('remote-auth-test only runs against the development environment.');
  let base: URL;
  try {
    base = new URL(baseUrl ?? '');
  } catch {
    fail('--base-url https://ar-creator-dev.<subdomain>.workers.dev is required');
  }
  if (base.protocol !== 'https:' || !base.hostname.startsWith('ar-creator-dev.') || !base.hostname.endsWith('.workers.dev') || base.pathname !== '/') {
    fail('Refusing: --base-url must be exactly https://ar-creator-dev.<subdomain>.workers.dev (the isolated dev Worker).');
  }

  const url = await connectionString('app');
  const c = new Client({ connectionString: url, application_name: 'ar-creator-remote-test', connectionTimeoutMillis: 15_000 });
  c.on('error', () => undefined);
  const userId = `remote-test-${randomBytes(8).toString('hex')}`;
  const email = `${userId}@ar-creator.invalid`;
  const password = `${randomBytes(24).toString('base64url')}Aa1!`;
  let seeded = false;
  const cleanup = async () => {
    if (!seeded) return;
    seeded = false;
    const r = await c.query('DELETE FROM "user" WHERE id = $1', [userId]);
    console.log(`\n  cleanup: removed ${r.rowCount} test user (sessions and accounts cascade)`);
  };
  process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)));
  try {
    await c.connect();
    const t = await inspect(c, url);
    report(t);
    if (t.marker !== 'development') fail(`Refusing: ar.environment is "${t.marker ?? 'unset'}", expected "development".`);
    if (!tlsOk(t, url)) fail('Refusing: the connection is not encrypted with a verified certificate.');
    if (t.user !== 'ar_app') fail(`Refusing: seed as the runtime role ar_app (connected as ${t.user}).`);

    const { hashPassword } = (await import(pathToFileURL(join(DB, 'node_modules', 'better-auth', 'dist', 'crypto', 'index.mjs')).href)) as {
      hashPassword: (p: string) => Promise<string>;
    };
    const hash = await hashPassword(password);
    await c.query('BEGIN');
    await c.query('INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)', [userId, 'Remote Test', email]);
    await c.query(`INSERT INTO account (id, account_id, provider_id, user_id, password, updated_at) VALUES ($1, $2, 'credential', $2, $3, now())`, [
      `${userId}-acct`,
      userId,
      hash,
    ]);
    await c.query('COMMIT');
    seeded = true;
    console.log(`\n  seeded temporary verified user ${email} (password random, never displayed)\n  running remote suite (auth + content) against ${base.origin}\n`);

    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--config', 'playwright.remote.config.ts'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, REMOTE_BASE_URL: base.origin, REMOTE_TEST_EMAIL: email, REMOTE_TEST_PASSWORD: password },
    });
    await cleanup();
    process.exitCode = r.status ?? 1;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    await cleanup().catch(() => undefined);
    const err = e as { code?: string; message?: string };
    fail(`Error${err.code ? ` [${err.code}]` : ''}: ${redact(String(err.message ?? e))}`);
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function main() {
  const { cmd, env, approved, baseUrl } = args();
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

  if (cmd === 'remote-auth-test') return remoteAuthTest(env, baseUrl);

  if (cmd === 'create-roles') {
    if (env === 'production' && !approved) fail('Creating production roles requires --approved (owner sign-off recorded in PROGRESS.md).');
    return createRoles(env);
  }

  const url = await connectionString('migrator');
  const c = new Client({ connectionString: url, application_name: 'ar-creator-migrate', connectionTimeoutMillis: 15_000 });
  c.on('error', () => undefined);
  try {
    await c.connect();
    const t = await inspect(c, url);
    const pending = report(t);
    if (t.marker !== env) {
      fail(`Refusing: ar.environment is "${t.marker ?? 'unset'}", expected "${env}". Set the marker on the correct branch (infra/db/NEON.md step 4: COMMENT ON DATABASE).`);
    }
    if (!tlsOk(t, url)) fail('Refusing: the connection is not encrypted with a verified certificate.');
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

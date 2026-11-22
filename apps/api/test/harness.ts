import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { connectDb } from '@ar-creator/db';
import { createApp } from '../src/app.ts';
import type { Mailer, OutboundEmail } from '../src/email/mailer.ts';
import type { RawAuthEnv } from '../src/auth/config.ts';
import type { DbConnector } from '../src/db.ts';
import { memoryStore } from '../src/assets/store.ts';

/** Minimal cookie jar: stores Set-Cookie name=value pairs, honours deletion (Max-Age=0 / empty value). */
export class Jar {
  readonly cookies = new Map<string, string>();
  readonly raw: string[] = [];
  store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      this.raw.push(c);
      const [pair, ...attrs] = c.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export interface Harness {
  base: string;
  mails: OutboundEmail[];
  /** In-memory object store standing in for R2 (the R2 adapter itself is tested in workerd). */
  store: ReturnType<typeof memoryStore>;
  req: (
    path: string,
    init?: { method?: string; body?: unknown; raw?: { bytes: Uint8Array; type: string; length?: string | null }; jar?: Jar; ip?: string; origin?: string | null; headers?: Record<string, string> },
  ) => Promise<Response>;
  sql: (q: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

const randomIp = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 254) + 1).join(".")}`;

export const TEST_SECRET = randomBytes(48).toString('base64url');

export function makeHarness(opts: { dbUrl: string; base?: string; env?: Partial<RawAuthEnv>; connect?: DbConnector }): Harness {
  const base = opts.base ?? 'http://localhost';
  const mails: OutboundEmail[] = [];
  const mailer: Mailer = { transport: 'dev-mailbox', send: async (m) => void mails.push(m) };
  const store = memoryStore();
  const app = createApp({ version: 'test', build: 'test' }, { connectDb: opts.connect ?? (() => connectDb(opts.dbUrl)), mailer: () => mailer, objectStore: () => store });
  const env: RawAuthEnv = {
    APP_ENV: 'development',
    BETTER_AUTH_SECRET: TEST_SECRET,
    EMAIL_TRANSPORT: 'dev-mailbox',
    AUTH_SIGNUP_ENABLED: 'true',
    ...opts.env,
  };
  const req: Harness['req'] = async (path, init = {}) => {
    // Distinct client IP per request unless a test pins one (rate limits are per IP; see rate-limit tests).
    const headers: Record<string, string> = { 'cf-connecting-ip': init.ip ?? randomIp(), ...(init.headers ?? {}) };
    if (init.origin !== null) headers.origin = init.origin ?? base;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.raw) {
      headers['content-type'] = init.raw.type;
      if (init.raw.length !== null) headers['content-length'] = init.raw.length ?? String(init.raw.bytes.length);
    }
    if (init.jar && init.jar.cookies.size) headers.cookie = init.jar.header();
    const res = await app.request(
      `${base}${path}`,
      {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.raw ? { body: init.raw.bytes } : {}),
        redirect: 'manual',
      },
      env as unknown as Env,
    );
    init.jar?.store(res);
    return res;
  };
  const sql: Harness['sql'] = async (q, params = []) => {
    const c = new Client({ connectionString: opts.dbUrl });
    await c.connect();
    try {
      const r = await c.query(q, params);
      return { rows: r.rows, rowCount: r.rowCount };
    } finally {
      await c.end();
    }
  };
  return { base, mails, store, req, sql };
}

export function linkIn(mail: OutboundEmail | undefined): string {
  const m = /https?:\/\/\S+/.exec(mail?.text ?? '');
  if (!m) throw new Error('no link in email');
  return m[0];
}

export const uniqueEmail = () => `user-${randomBytes(5).toString('hex')}@example.com`;
export const PASSWORD = 'correct horse battery staple';

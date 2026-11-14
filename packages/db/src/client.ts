import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.ts';
import { redact } from './redact.ts';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  /** Raw client for health checks and tests. Never share across requests. */
  client: Client;
  close(): Promise<void>;
}

export type DbFailureKind = 'not_configured' | 'timeout' | 'unreachable' | 'auth' | 'misconfigured' | 'query_failed' | 'unknown';

/** Safe-to-expose classification; `detail` is redacted and intended for server logs only. */
export class DatabaseError extends Error {
  override name = 'DatabaseError';
  readonly kind: DbFailureKind;
  readonly detail: string;
  constructor(kind: DbFailureKind, detail: string) {
    super(`database ${kind}`);
    this.kind = kind;
    this.detail = redact(detail);
  }
}

export function classifyDbError(err: unknown): DatabaseError {
  if (err instanceof DatabaseError) return err;
  const e = err as { code?: string; message?: string } | undefined;
  const code = e?.code ?? '';
  const msg = String(e?.message ?? err);
  let kind: DbFailureKind = 'unknown';
  if (code === '28P01' || code === '28000') kind = 'auth'; // invalid_password / invalid_authorization_specification
  else if (code === '3D000' || code === '42P01') kind = 'misconfigured'; // database / relation does not exist
  else if (code === '57014' || /timeout|timed out/i.test(msg)) kind = 'timeout'; // query_canceled (statement_timeout)
  else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|Connection terminated|connect/i.test(code + ' ' + msg)) kind = 'unreachable';
  else if (code) kind = 'query_failed';
  return new DatabaseError(kind, `${code ? `[${code}] ` : ''}${msg}`);
}

export interface ConnectOptions {
  connectionTimeoutMs?: number;
  /** Server-side statement_timeout; protects the Worker from runaway queries. */
  statementTimeoutMs?: number;
}

/**
 * Open ONE connection for ONE Worker request (Cloudflare Hyperdrive guidance; Workers forbid I/O objects
 * shared across requests). Callers must `close()` it — in Workers via `ctx.waitUntil(handle.close())`.
 * Hyperdrive is configured with query caching DISABLED (ADR-013 §5, ADR-017), so reads are consistent.
 */
export async function connectDb(connectionString: string, opts: ConnectOptions = {}): Promise<DbHandle> {
  if (!connectionString) throw new DatabaseError('not_configured', 'empty connection string');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
    statement_timeout: opts.statementTimeoutMs ?? 10_000,
    application_name: 'ar-creator',
  });
  // pg emits 'error' on idle-connection failures; without a listener that would crash the isolate.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => undefined);
    throw classifyDbError(err);
  }
  let closed = false;
  return {
    db: drizzle(client, { schema }),
    client,
    close: async () => {
      if (closed) return;
      closed = true;
      await client.end().catch(() => undefined);
    },
  };
}

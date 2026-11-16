import type { Client } from 'pg';

export interface ClientTls {
  /** The socket between THIS client and the server endpoint is TLS. */
  encrypted: boolean;
  /** The server certificate chain and hostname were verified. */
  verified: boolean;
  protocol: string | null;
}

/**
 * TLS as seen by the client. Do not use `pg_stat_ssl` for this: on Neon the client's TLS terminates at Neon's
 * proxy, and the proxy→compute hop reports `ssl = false` even though the client connection is encrypted.
 * node-postgres swaps `connection.stream` for a `tls.TLSSocket` when TLS is negotiated.
 */
export function clientTls(c: Client): ClientTls {
  const s = (c as unknown as { connection?: { stream?: { encrypted?: boolean; authorized?: boolean; getProtocol?: () => string | null } } }).connection?.stream;
  return { encrypted: s?.encrypted === true, verified: s?.authorized === true, protocol: s?.getProtocol?.() ?? null };
}

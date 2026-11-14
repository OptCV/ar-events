import { Hono } from 'hono';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createAuth, type Auth, type AuthEnv } from './auth.ts';
import * as schema from './schema.ts';

type Env = AuthEnv & { HYPERDRIVE: Hyperdrive };
type Vars = { auth: Auth; timings: Record<string, number> };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Per request: new pg Client over Hyperdrive (Cloudflare guidance) + new auth instance bound to it.
app.use('*', async (c, next) => {
  const t0 = Date.now();
  const client = new Client({ connectionString: c.env.HYPERDRIVE.connectionString });
  await client.connect();
  const db = drizzle(client, { schema });
  c.set('auth', createAuth(db, c.env));
  c.set('timings', { connectMs: Date.now() - t0 });
  try {
    await next();
  } finally {
    // Close after the response is sent; never reuse the client across requests.
    c.executionCtx.waitUntil(client.end());
  }
  c.header('x-spike-connect-ms', String(c.get('timings').connectMs));
  c.header('x-spike-total-ms', String(Date.now() - t0));
});

app.on(['GET', 'POST'], '/api/auth/*', (c) => c.get('auth').handler(c.req.raw));

// Example protected route: ownership checks in Phase 1 hang off this session lookup.
app.get('/api/me', async (c) => {
  const session = await c.get('auth').api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ userId: session.user.id, email: session.user.email });
});

app.get('/api/health', (c) => c.json({ ok: true }));

export default app;

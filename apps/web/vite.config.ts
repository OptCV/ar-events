import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Local only: make CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE (gitignored repo-root .env) visible to the
// Cloudflare plugin so the Worker's HYPERDRIVE binding points at Docker Postgres in `vite dev`/`vite preview`.
// Vite only exposes VITE_-prefixed variables to client code, and nothing here is passed to `define`,
// so these values never reach the browser bundle (asserted by tests/e2e/app/database.spec.ts).
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // No .env (e.g. CI without a database): /api/health reports the database as not configured/unreachable.
}

function gitSha(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'dev';
  }
}

/**
 * One Worker, one origin (ADR-014): the Cloudflare plugin runs the Worker (apps/api, see wrangler.jsonc `main`)
 * inside workerd for `vite dev` and `vite preview`, and builds client assets + Worker for deployment.
 */
export default defineConfig(({ command }) => ({
  plugins: [react(), cloudflare()],
  define: {
    // Available to both the client and the Worker environment.
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(command === 'build' ? gitSha() : 'dev'),
  },
  // Client source maps would be deployed as public static assets → off. Worker maps are uploaded privately
  // (`upload_source_maps` in wrangler.jsonc) for readable stack traces in Workers Observability.
  build: { sourcemap: false, manifest: process.env.BUNDLE_MANIFEST === '1' },
  environments: { ar_creator: { build: { sourcemap: true } } },
}));

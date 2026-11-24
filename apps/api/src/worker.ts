/**
 * Worker entry for the single AR Creator Worker (ADR-014). Static assets (the SPA) are served by
 * Workers Static Assets before this code runs; `/api/*` is routed here first (`run_worker_first`).
 * Also exports the Image-to-AR Workflow and the USD converter Container class (ADR-023), and runs the daily
 * maintenance sweep from the cron trigger (ADR-039).
 */
import { createApp } from './app.ts';
import { r2Store } from './assets/store.ts';
import { hyperdriveConnector } from './db.ts';
import { sweep } from './maintenance.ts';

export { ImageToArWorkflow, UsdConverterContainer } from './conversions/workflow.ts';

declare const __APP_VERSION__: string;
declare const __BUILD_SHA__: string;

const app = createApp({ version: __APP_VERSION__, build: __BUILD_SHA__ });

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    const run = async () => {
      const h = await hyperdriveConnector(env);
      try {
        const r = await sweep(h.db, r2Store(env.ASSETS_BUCKET), new Date(), (detail) => console.error(JSON.stringify({ level: 'error', event: 'maintenance.object-delete', detail })));
        console.log(JSON.stringify({ level: 'info', event: 'maintenance.sweep', ...r }));
      } finally {
        await h.close();
      }
    };
    ctx.waitUntil(run());
  },
} satisfies ExportedHandler<Env>;

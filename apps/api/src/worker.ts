/**
 * Worker entry for the single AR Creator Worker (ADR-014). Static assets (the SPA) are served by
 * Workers Static Assets before this code runs; `/api/*` is routed here first (`run_worker_first`).
 * Also exports the Image-to-AR Workflow and the USD converter Container class (ADR-023).
 */
import { createApp } from './app.ts';

export { ImageToArWorkflow, UsdConverterContainer } from './conversions/workflow.ts';

declare const __APP_VERSION__: string;
declare const __BUILD_SHA__: string;

const app = createApp({ version: __APP_VERSION__, build: __BUILD_SHA__ });

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

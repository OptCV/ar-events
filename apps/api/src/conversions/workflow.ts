/**
 * Cloudflare runtime pieces of the Image-to-AR pipeline (ADR-023). Imported only by worker.ts: these depend on
 * `cloudflare:*` modules that do not exist in Node.
 *
 *  - `UsdConverterContainer`: the OpenUSD converter image (services/usd-processor, `runtime` stage) as a
 *    Cloudflare Container, started with internet access DISABLED. The Worker streams the source in and stores the
 *    result; the container never sees credentials, storage or other users' data.
 *  - `ImageToArWorkflow`: one durable instance per conversion attempt. Steps are idempotent (pipeline.ts), so a
 *    retried or replayed step reuses its earlier output. User-caused failures are not retried.
 */
import { Container, getRandom } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { CONVERSION_ERRORS, type ConversionErrorCode } from '@ar-creator/contracts';
import { r2Store } from '../assets/store.ts';
import { hyperdriveConnector } from '../db.ts';
import { asFailure, buildGlbStep, buildUsdzStep, failJob, finishJob, prepareTextureStep, startJob, type GlbStepResult, type JobContext, type PipelineDeps, type TextureRef, type UsdzStepResult } from './pipeline.ts';
import type { ImageToArParams } from './runner.ts';
import { converterPool, httpUsdConverter, type UsdConverter } from './usd.ts';
import { asBuildFailure, compileOutputStep, failBuild, finishBuild, isBuildError, startBuild, type BuildContext, type OutputResult } from '../compile/pipeline.ts';

export class UsdConverterContainer extends Container<Env> {
  override defaultPort = 8080;
  /** Keep a warm instance briefly for back-to-back conversions; it stops (and stops billing) after this. */
  override sleepAfter = '3m';
  /** The converter needs no network: inputs arrive in the request body. */
  override enableInternet = false;
}

/**
 * The Container in deployed Workers. Local development only (APP_ENV=development): the same converter image run by
 * Docker at USD_CONVERTER_URL, because Cloudflare Containers cannot run locally on Windows. A deployed Worker never
 * reads USD_CONVERTER_URL, so it cannot be pointed at another host by configuration.
 */
export function usdConverter(env: Env): UsdConverter {
  const local = (env as { USD_CONVERTER_URL?: string }).USD_CONVERTER_URL;
  if ((env as { APP_ENV?: string }).APP_ENV === 'development' && local) {
    const base = new URL(local);
    if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('USD_CONVERTER_URL must be a loopback address');
    return httpUsdConverter((req) => fetch(req), base.origin);
  }
  return httpUsdConverter(async (req) => (await getRandom(env.USD_CONVERTER, converterPool(env as { USD_CONVERTER_POOL?: string }))).fetch(req));
}

/** Failures cross step boundaries as plain error messages: `conversion:<code>:<message>`. */
const encode = (code: ConversionErrorCode, message: string) => `conversion:${code}:${message}`;
function decode(e: unknown): { code: ConversionErrorCode; message: string } {
  const m = /^(?:[A-Za-z]*Error: )?conversion:([a-z_]+):([\s\S]*)$/.exec(String((e as Error)?.message ?? e));
  if (m && (CONVERSION_ERRORS as readonly string[]).includes(m[1]!)) return { code: m[1] as ConversionErrorCode, message: m[2]! };
  return { code: 'internal', message: 'Something went wrong while converting. Try again.' };
}

export class ImageToArWorkflow extends WorkflowEntrypoint<Env, ImageToArParams> {
  private async withDeps<T>(fn: (d: PipelineDeps) => Promise<T>): Promise<T> {
    const h = await hyperdriveConnector(this.env);
    try {
      return await fn({ db: h.db, store: r2Store(this.env.ASSETS_BUCKET), usd: usdConverter(this.env) });
    } finally {
      await h.close();
    }
  }

  /** Run a pipeline step; user-caused failures become NonRetryableError so the Workflow stops retrying them. */
  private async guarded<T>(fn: (d: PipelineDeps) => Promise<T>): Promise<T> {
    try {
      return await this.withDeps(fn);
    } catch (e) {
      const f = asFailure(e);
      if (f.code === 'internal') console.error(JSON.stringify({ level: 'error', event: 'conversion.step', detail: String((e as Error)?.stack ?? e) }));
      if (!f.retryable) throw new NonRetryableError(encode(f.code, f.message));
      throw new Error(encode(f.code, f.message));
    }
  }

  /** Test builds (ADR-034): start → android (GLB) → ios (USDZ) → finish; same retry and failure handling. */
  private async runBuild(jobId: string, step: WorkflowStep): Promise<void> {
    const quick = { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' } as const;
    const container = { retries: { limit: 4, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' } as const;
    const guarded = async <T,>(fn: (d: PipelineDeps) => Promise<T>): Promise<T> => {
      try {
        return await this.withDeps(fn);
      } catch (e) {
        const f = asBuildFailure(e);
        if (f.code === 'internal') console.error(JSON.stringify({ level: 'error', event: 'build.step', detail: String((e as Error)?.stack ?? e) }));
        if (!f.retryable) throw new NonRetryableError(`build:${f.code}:${f.message}`);
        throw new Error(`build:${f.code}:${f.message}`);
      }
    };
    try {
      const ctx = (await step.do('start', quick, () => guarded((d) => startBuild(d, jobId)) as never)) as BuildContext;
      const android = (await step.do('android', container, () => guarded((d) => compileOutputStep(d, ctx, 'android')) as never)) as OutputResult;
      const ios = (await step.do('ios', container, () => guarded((d) => compileOutputStep(d, ctx, 'ios')) as never)) as OutputResult;
      await step.do('finish', quick, () => guarded((d) => finishBuild(d, ctx, [android, ios])) as never);
    } catch (e) {
      const m = /^(?:[A-Za-z]*Error: )?build:([a-z_]+):([sS]*)$/.exec(String((e as Error)?.message ?? e));
      const code = m && isBuildError(m[1]!) ? m[1]! : 'internal';
      const message = m && isBuildError(m[1]!) ? m[2]! : 'Something went wrong while building. Try again.';
      await step.do('fail', quick, () => this.withDeps((d) => failBuild(d, jobId, code as never, message)) as never);
    }
  }

  override async run(event: Readonly<WorkflowEvent<ImageToArParams>>, step: WorkflowStep): Promise<void> {
    const { jobId } = event.payload;
    if (event.payload.kind === 'build') return this.runBuild(jobId, step);
    const quick = { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' } as const;
    try {
      const ctx = (await step.do('start', quick, () => this.guarded((d) => startJob(d, jobId)) as never)) as JobContext;
      // Container steps: cold-starting a container can take a while; retry generously before giving up.
      const container = { retries: { limit: 4, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' } as const;
      const tex = (await step.do('texture', container, () => this.guarded((d) => prepareTextureStep(d, ctx)) as never)) as TextureRef;
      const glb = (await step.do('glb', { ...quick, timeout: '5 minutes' }, () => this.guarded((d) => buildGlbStep(d, ctx, tex)) as never)) as GlbStepResult;
      const usdz = (await step.do('usdz', container, () => this.guarded((d) => buildUsdzStep(d, ctx, tex, glb)) as never)) as UsdzStepResult;
      await step.do('finish', quick, () => this.guarded((d) => finishJob(d, ctx, glb, usdz)) as never);
    } catch (e) {
      const f = decode(e);
      await step.do('fail', quick, () => this.withDeps((d) => failJob(d, jobId, f.code, f.message)) as never);
    }
  }
}

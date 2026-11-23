/**
 * How a queued conversion gets executed (ADR-023).
 *  - `workflowRunner`: production and `vite dev` — one Cloudflare Workflow instance per attempt (durable steps,
 *    bounded retries). The instance id `${jobId}-a${attempt}` makes a duplicate start for the same attempt a no-op.
 *  - `inlineRunner`: Node integration tests — runs the same pipeline steps in-process.
 */
import { runConversion, type PipelineDeps } from './pipeline.ts';
import { runBuild } from '../compile/pipeline.ts';

/** What a job does: an image-object conversion (ADR-023) or a test build (ADR-034). */
export type JobKind = 'image-object' | 'build';

export interface ConversionRunner {
  start(jobId: string, attempt: number, kind?: JobKind): Promise<void>;
}

/** Workflow params. One Workflow class runs both kinds (no extra Cloudflare binding); `kind` absent = image object. */
export interface ImageToArParams {
  jobId: string;
  kind?: JobKind;
}

export const workflowInstanceId = (jobId: string, attempt: number) => `${jobId}-a${attempt}`;

export function workflowRunner(binding: Workflow<ImageToArParams>): ConversionRunner {
  return {
    async start(jobId, attempt, kind = 'image-object') {
      try {
        await binding.create({ id: workflowInstanceId(jobId, attempt), params: { jobId, kind } });
      } catch (e) {
        // Already started for this attempt (a retried request): nothing to do.
        if (/already[_ ]exists/i.test(String((e as Error).message))) return;
        throw e;
      }
    },
  };
}

/** Runs conversions in the background of the current process; `idle()` resolves when all have settled. */
export function inlineRunner(deps: () => Promise<PipelineDeps & { close?: () => Promise<void> }>): ConversionRunner & { idle(): Promise<void> } {
  const running = new Set<Promise<void>>();
  return {
    async start(jobId, _attempt, kind = 'image-object') {
      const p = (async () => {
        const d = await deps();
        try {
          if (kind === 'build') await runBuild(d, jobId);
          else await runConversion(d, jobId);
        } finally {
          await d.close?.();
        }
      })().catch((e) => console.error('inline conversion failed', e));
      running.add(p);
      void p.finally(() => running.delete(p));
    },
    async idle() {
      while (running.size) await Promise.all([...running]);
    },
  };
}

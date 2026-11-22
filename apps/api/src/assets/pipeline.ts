/**
 * Streaming upload pipeline (ADR-022). A TransformStream placed between the request body and storage that:
 *   1. holds back the first bytes until the file head can be inspected (nothing reaches storage before that);
 *   2. counts bytes and fails as soon as the declared size is exceeded;
 *   3. hashes every byte (SHA-256) and checks the tail and the optional declared checksum at the end.
 * Any failure ERRORS the stream, so the storage write aborts and no object is committed.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import type { AssetMime, FileRejection, UploadableRole } from '@ar-creator/contracts';
import { HEAD_BYTES, TAIL_BYTES, inspectHead, inspectTail, type InspectionOk } from './inspect.ts';

export class UploadRejected extends Error {
  override name = 'UploadRejected';
  readonly code: FileRejection;
  constructor(code: FileRejection, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PipelineOptions {
  role: UploadableRole;
  declaredType: string;
  /** Exact byte count the client declared; anything else is rejected. */
  size: number;
  /** When set, the computed checksum must equal it. */
  expectedSha256?: string | undefined;
}

export interface PipelineOutcome {
  sha256: string;
  size: number;
  inspection: InspectionOk;
}

interface Hasher {
  update(chunk: Uint8Array): void;
  digestHex(): Promise<string>;
}

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

/** Native `crypto.DigestStream` in workerd; pure-JS SHA-256 elsewhere (Node test runs). Same output. */
export function createHasher(): Hasher {
  const DS = (globalThis as { crypto?: { DigestStream?: typeof DigestStream } }).crypto?.DigestStream;
  if (DS) {
    const ds = new DS('SHA-256');
    const writer = ds.getWriter();
    let pending: Promise<void> = Promise.resolve();
    return {
      update(chunk) {
        pending = pending.then(() => writer.write(chunk));
      },
      async digestHex() {
        await pending;
        await writer.close();
        return hex(await ds.digest);
      },
    };
  }
  const h = nobleSha256.create();
  return {
    update: (chunk) => void h.update(chunk),
    digestHex: async () => hex(h.digest()),
  };
}

export function createUploadPipeline(opts: PipelineOptions): { transform: TransformStream<Uint8Array, Uint8Array>; outcome: () => PipelineOutcome } {
  const headTarget = Math.min(opts.size, HEAD_BYTES[opts.role]);
  const hasher = createHasher();
  let received = 0;
  let head: Uint8Array[] | null = [];
  let headLength = 0;
  let inspection: InspectionOk | null = null;
  let tail = new Uint8Array(0);
  let result: PipelineOutcome | null = null;

  const keepTail = (chunk: Uint8Array) => {
    const joined = new Uint8Array(Math.min(TAIL_BYTES, tail.length + chunk.length));
    const fromChunk = Math.min(chunk.length, joined.length);
    const fromTail = joined.length - fromChunk;
    joined.set(tail.subarray(tail.length - fromTail), 0);
    joined.set(chunk.subarray(chunk.length - fromChunk), fromTail);
    tail = joined;
  };

  const inspectBufferedHead = (controller: TransformStreamDefaultController<Uint8Array>) => {
    const buf = new Uint8Array(headLength);
    let o = 0;
    for (const c of head!) {
      buf.set(c, o);
      o += c.length;
    }
    const r = inspectHead(opts.role, opts.declaredType, buf, opts.size);
    if (!r.ok) throw new UploadRejected(r.code, r.message);
    inspection = r;
    for (const c of head!) controller.enqueue(c);
    head = null;
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) throw new UploadRejected('corrupt', 'Unexpected upload data.');
      received += chunk.length;
      if (received > opts.size) throw new UploadRejected('size_mismatch', 'The file is larger than declared.');
      hasher.update(chunk);
      keepTail(chunk);
      if (head) {
        head.push(chunk);
        headLength += chunk.length;
        if (headLength >= headTarget) inspectBufferedHead(controller);
        return;
      }
      controller.enqueue(chunk);
    },
    async flush(controller) {
      if (received !== opts.size) throw new UploadRejected('size_mismatch', 'The upload ended before the whole file arrived.');
      if (head) inspectBufferedHead(controller); // file smaller than the head window (never for size > 0 … kept for safety)
      const tailProblem = inspectTail(inspection!.mime as AssetMime, tail);
      if (tailProblem) throw new UploadRejected(tailProblem.code, tailProblem.message);
      const sha256 = await hasher.digestHex();
      if (opts.expectedSha256 && opts.expectedSha256 !== sha256) {
        throw new UploadRejected('checksum_mismatch', 'The uploaded file does not match its checksum. Try uploading it again.');
      }
      result = { sha256, size: received, inspection: inspection! };
    },
  });
  return {
    transform,
    outcome: () => {
      if (!result) throw new Error('upload pipeline has not finished');
      return result;
    },
  };
}

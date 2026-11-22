/**
 * Object storage behind a narrow interface (ADR-022) so routes never touch R2 directly, tests can use memory, and
 * a later presigned/multipart strategy only adds methods here. Keys are always server-generated.
 */

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  size: number;
}

export interface ObjectStore {
  /** Atomic write: if `body` errors, nothing is stored (and any existing object at `key` is untouched). */
  put(key: string, body: ReadableStream<Uint8Array>, opts: { size: number; contentType: string; sha256Hex?: string }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
}

/** R2 adapter. `FixedLengthStream` gives R2 the known length it requires for streamed puts. */
export function r2Store(bucket: R2Bucket): ObjectStore {
  return {
    async put(key, body, opts) {
      const fixed = new FixedLengthStream(opts.size);
      const piping = body.pipeTo(fixed.writable);
      const putting = bucket.put(key, fixed.readable, {
        httpMetadata: { contentType: opts.contentType },
        // R2 verifies the checksum server-side as well when the client declared one.
        ...(opts.sha256Hex ? { sha256: opts.sha256Hex } : {}),
      });
      const [p, w] = await Promise.allSettled([piping, putting]);
      // Prefer the pipeline's own error (e.g. UploadRejected) over R2's generic stream error.
      if (p.status === 'rejected') throw p.reason;
      if (w.status === 'rejected') throw w.reason;
    },
    async get(key) {
      const obj = await bucket.get(key);
      return obj ? { body: obj.body, size: obj.size } : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

/** In-memory adapter for Node tests: same atomicity contract (stores only after the stream completes). */
export function memoryStore(): ObjectStore & { objects: Map<string, { bytes: Uint8Array; contentType: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    async put(key, body, opts) {
      const chunks: Uint8Array[] = [];
      let n = 0;
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        n += value.length;
      }
      if (n !== opts.size) throw new Error(`length mismatch: expected ${opts.size}, got ${n}`);
      const bytes = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) {
        bytes.set(c, o);
        o += c.length;
      }
      objects.set(key, { bytes, contentType: opts.contentType });
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      const bytes = o.bytes;
      return { size: bytes.length, body: new ReadableStream({ start: (c) => (c.enqueue(bytes), c.close()) }) };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

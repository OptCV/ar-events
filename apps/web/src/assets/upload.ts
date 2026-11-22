import { ApiError, AssetSummary, CreateUploadResponse, MIME, ROLE_POLICY, formatBytes, unsupportedTypeMessage, type UploadableRole } from '@ar-creator/contracts';
import { ApiRequestError, sendJson } from '../api/client.ts';

export type UploadPhase = 'checking' | 'uploading' | 'processing';
export interface UploadProgress {
  phase: UploadPhase;
  /** 0–1 while uploading. */
  fraction: number;
}

/** Browsers often report '' or application/octet-stream for .glb; fall back to the extension (the server re-checks bytes). */
export function fileType(file: File): string {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (file.type && file.type !== 'application/octet-stream') return file.type === 'image/jpg' ? MIME.jpeg : file.type;
  if (ext === 'glb') return MIME.glb;
  if (ext === 'png') return MIME.png;
  if (ext === 'jpg' || ext === 'jpeg') return MIME.jpeg;
  if (ext === 'webp') return MIME.webp;
  return file.type || 'application/octet-stream';
}

/** Early, friendly checks. The server repeats all of them and inspects the actual bytes. */
export function checkFile(file: File, role: UploadableRole): string | null {
  const policy = ROLE_POLICY[role];
  const type = fileType(file);
  if (!(policy.types as readonly string[]).includes(type)) return unsupportedTypeMessage(role, type);
  if (file.size === 0) return 'The file is empty.';
  if (file.size > policy.maxBytes) return `This file is ${formatBytes(file.size)}. ${policy.label}s can be at most ${formatBytes(policy.maxBytes)}.`;
  return null;
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reserve an upload slot, then send the bytes to the target the server chose. The client follows
 * `upload.strategy`, so switching the server to presigned R2 URLs later needs no UI change; `multipart` is not
 * implemented in this client yet and fails clearly.
 */
export async function uploadAsset(file: File, role: UploadableRole, opts: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal } = {}): Promise<AssetSummary> {
  const problem = checkFile(file, role);
  if (problem) throw new ApiRequestError(0, 'invalid_file', problem);
  opts.onProgress?.({ phase: 'checking', fraction: 0 });
  const sha256 = await sha256Hex(file); // lets the server (and R2) verify end-to-end integrity
  if (opts.signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
  const slot = await sendJson('POST', '/api/assets/uploads', { role, filename: file.name, contentType: fileType(file), sizeBytes: file.size, sha256 }, CreateUploadResponse);
  if (slot.upload.strategy === 'multipart') throw new ApiRequestError(0, 'unsupported', 'This upload needs a newer version of the app. Reload the page and try again.');
  return send(file, slot.upload, opts);
}

function send(file: File, target: CreateUploadResponse['upload'], opts: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal }): Promise<AssetSummary> {
  return new Promise((resolve, reject) => {
    // XMLHttpRequest: fetch() cannot report upload progress.
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.withCredentials = false; // same-origin requests send cookies anyway; never send them cross-origin
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.({ phase: e.loaded >= e.total ? 'processing' : 'uploading', fraction: e.loaded / e.total });
    };
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* handled below */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = AssetSummary.safeParse(data);
        return parsed.success ? resolve(parsed.data) : reject(new ApiRequestError(xhr.status, 'contract', 'The server sent an unexpected response.'));
      }
      const e = ApiError.safeParse(data);
      reject(e.success ? new ApiRequestError(xhr.status, e.data.error.code, e.data.error.message, e.data.error) : new ApiRequestError(xhr.status, 'http', `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new ApiRequestError(0, 'network', 'The upload was interrupted. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    opts.onProgress?.({ phase: 'uploading', fraction: 0 });
    xhr.send(file);
  });
}

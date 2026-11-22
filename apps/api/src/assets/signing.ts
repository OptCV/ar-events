/**
 * Short-lived signed read URLs for private assets (ADR-022). Native AR viewers (Scene Viewer, Quick Look) fetch
 * files without cookies, so reads are authorised by an HMAC over the asset id, its content hash and an expiry.
 * The HMAC key is derived from BETTER_AUTH_SECRET with HKDF and a dedicated label (domain separation: the key
 * cannot be used for, or derived from, session signing). Verification uses `crypto.subtle.verify` (constant time).
 */

/** Upper bound on any signed URL lifetime, even if a signer asked for more. */
export const MAX_TTL_SECONDS = 24 * 60 * 60;
const LABEL = new TextEncoder().encode('ar-creator/asset-read-url/v1');
const keys = new Map<string, Promise<CryptoKey>>();

export function assetSigningKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: LABEL },
        ikm,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
      );
    })();
    if (keys.size > 8) keys.clear(); // secrets rarely change; bound the cache anyway
    keys.set(secret, k);
  }
  return k;
}

const message = (assetId: string, sha256: string, exp: number) => new TextEncoder().encode(`asset-read/v1\n${assetId}\n${sha256}\n${exp}`);

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return null; // 32-byte HMAC
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '=');
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

/** `origin` must be the app's own origin; the path is fixed so a signature can never authorise another route. */
export async function signAssetUrl(key: CryptoKey, origin: string, a: { id: string; sha256: string }, ttlSeconds: number, now = Date.now()): Promise<SignedUrl> {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = b64url(await crypto.subtle.sign('HMAC', key, message(a.id, a.sha256, exp)));
  const qs = new URLSearchParams({ v: a.sha256.slice(0, 16), exp: String(exp), sig });
  return { url: `${origin}/api/assets/${a.id}/content?${qs}`, expiresAt: new Date(exp * 1000) };
}

export type VerifyResult = { ok: true; expiresInSeconds: number } | { ok: false; reason: 'malformed' | 'expired' | 'bad_signature' };

export async function verifyAssetUrl(key: CryptoKey, a: { id: string; sha256: string }, q: { v?: string | undefined; exp?: string | undefined; sig?: string | undefined }, now = Date.now()): Promise<VerifyResult> {
  if (!q.v || !q.exp || !q.sig || !/^\d{1,12}$/.test(q.exp)) return { ok: false, reason: 'malformed' };
  const sig = fromB64url(q.sig);
  if (!sig) return { ok: false, reason: 'malformed' };
  const exp = Number(q.exp);
  const remaining = exp - Math.floor(now / 1000);
  if (remaining <= 0) return { ok: false, reason: 'expired' };
  if (remaining > MAX_TTL_SECONDS) return { ok: false, reason: 'malformed' };
  if (q.v !== a.sha256.slice(0, 16)) return { ok: false, reason: 'bad_signature' };
  const valid = await crypto.subtle.verify('HMAC', key, sig, message(a.id, a.sha256, exp));
  return valid ? { ok: true, expiresInSeconds: remaining } : { ok: false, reason: 'bad_signature' };
}

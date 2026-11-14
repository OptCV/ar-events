/**
 * Outbound-link policy shared by actions, native launch params and landing pages.
 * SECURITY.md: allowlist https, mailto, tel. Everything else (javascript:, data:,
 * http:, blob:, file:, intent:, custom schemes) is rejected.
 */
export const ALLOWED_LINK_PROTOCOLS = ['https:', 'mailto:', 'tel:'] as const;
export type AllowedLinkProtocol = (typeof ALLOWED_LINK_PROTOCOLS)[number];

export type UrlCheck =
  | { ok: true; url: URL; protocol: AllowedLinkProtocol }
  | { ok: false; reason: string };

// C0 controls, DEL, and whitespace anywhere in the raw string indicate smuggling attempts.
const CONTROL_OR_SPACE = new RegExp('[\u0000-\u0020\u007f-\u009f\u2028\u2029]');

export function checkOutboundUrl(
  raw: string,
  allowed: readonly AllowedLinkProtocol[] = ALLOWED_LINK_PROTOCOLS,
): UrlCheck {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty URL' };
  if (raw.length > 2048) return { ok: false, reason: 'URL longer than 2048 characters' };
  if (CONTROL_OR_SPACE.test(raw)) return { ok: false, reason: 'URL contains whitespace or control characters' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not an absolute URL' };
  }
  const protocol = url.protocol as AllowedLinkProtocol;
  if (!allowed.includes(protocol)) return { ok: false, reason: `protocol ${url.protocol} is not allowed` };
  if (protocol === 'https:') {
    if (!url.hostname) return { ok: false, reason: 'https URL has no host' };
    if (url.username || url.password) return { ok: false, reason: 'credentials in URL are not allowed' };
  }
  return { ok: true, url, protocol };
}

/** Assets handed to native viewers (Scene Viewer `file`, Quick Look href) must be HTTPS. */
export function checkHostedAssetUrl(raw: string): UrlCheck {
  return checkOutboundUrl(raw, ['https:']);
}

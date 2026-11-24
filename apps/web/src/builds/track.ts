import type { AnalyticsEventInput } from '@ar-creator/contracts';

export type Track = (e: AnalyticsEventInput) => void;

/**
 * Anonymous counters for a published experience (ADR-037): fire-and-forget, no cookies, nothing about the visitor
 * (the server only adds one to a daily count). Survives navigation (keepalive) so a tap that leaves the page counts.
 */
export function tracker(slug: string): Track {
  return (e) => {
    void fetch(`/api/public/${encodeURIComponent(slug)}/events`, {
      method: 'POST',
      keepalive: true,
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(e),
    }).catch(() => undefined);
  };
}

export const linkKind = (href: string): 'web' | 'email' | 'phone' => (href.startsWith('mailto:') ? 'email' : href.startsWith('tel:') ? 'phone' : 'web');

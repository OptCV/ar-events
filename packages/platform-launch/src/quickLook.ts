import { checkHostedAssetUrl, checkOutboundUrl } from '@ar-creator/schema';
import { LaunchParamError } from './sceneViewer.ts';

/**
 * AR Quick Look launch href builder for `<a rel="ar" href="…usdz#…"><img …></a>`.
 * Reference: https://developer.apple.com/documentation/arkit/adding-an-apple-pay-button-or-a-custom-action-in-ar-quick-look
 * The banner is native chrome; tapping the CTA posts a message event to the anchor element
 * (QUICK_LOOK_TAP_MESSAGE). The page then performs the action itself.
 */
export const QUICK_LOOK_TAP_MESSAGE = '_apple_ar_quicklook_button_tapped';
export const USDZ_MIME = 'model/vnd.usdz+zip';

export interface QuickLookParams {
  usdzUrl: string;
  /** Banner CTA text, e.g. "Visit site". Requires the page to handle QUICK_LOOK_TAP_MESSAGE. */
  callToAction?: string;
  checkoutTitle?: string;
  checkoutSubtitle?: string;
  /** false → allowsContentScaling=0 (fixed real-world scale). */
  allowsContentScaling?: boolean;
  /** Shared via the Quick Look share sheet instead of the raw USDZ URL. */
  canonicalWebPageUrl?: string;
}

const TEXT_MAX = 60;
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TEXT_MAX);

export function buildQuickLookHref(p: QuickLookParams): string {
  const r = checkHostedAssetUrl(p.usdzUrl);
  if (!r.ok) throw new LaunchParamError('usdzUrl', r.reason);
  const base = new URL(r.url.href);
  base.hash = '';
  const frag: [string, string][] = [];
  if (p.callToAction !== undefined && clean(p.callToAction)) frag.push(['callToAction', clean(p.callToAction)]);
  if (p.checkoutTitle !== undefined && clean(p.checkoutTitle)) frag.push(['checkoutTitle', clean(p.checkoutTitle)]);
  if (p.checkoutSubtitle !== undefined && clean(p.checkoutSubtitle)) frag.push(['checkoutSubtitle', clean(p.checkoutSubtitle)]);
  if (p.allowsContentScaling === false) frag.push(['allowsContentScaling', '0']);
  if (p.canonicalWebPageUrl !== undefined) {
    const c = checkOutboundUrl(p.canonicalWebPageUrl, ['https:']);
    if (!c.ok) throw new LaunchParamError('canonicalWebPageUrl', c.reason);
    frag.push(['canonicalWebPageURL', c.url.href]);
  }
  if (frag.length === 0) return base.href;
  return `${base.href}#${frag.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/**
 * Wire the Quick Look CTA tap to a validated https URL. Returns a disposer.
 * Only works on the exact `<a rel="ar">` element used to launch Quick Look.
 */
export function onQuickLookTap(anchor: EventTarget, targetUrl: string, open: (url: string) => void): () => void {
  const r = checkOutboundUrl(targetUrl, ['https:']);
  if (!r.ok) throw new LaunchParamError('targetUrl', r.reason);
  const href = r.url.href;
  const handler = (event: Event) => {
    if ((event as MessageEvent).data === QUICK_LOOK_TAP_MESSAGE) open(href);
  };
  anchor.addEventListener('message', handler, false);
  return () => anchor.removeEventListener('message', handler, false);
}

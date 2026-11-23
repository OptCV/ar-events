import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { detectOs, viewInAr, type DeviceEnv } from '@ar-creator/platform-launch';
import type { ConversionSummary } from '@ar-creator/contracts';
import { cx } from '../components/cx.ts';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import styles from './ImageObjects.module.css';

/**
 * Quick Look only opens from `<a rel="ar">` whose first child is an image (Apple's requirement). The img is a
 * transparent pixel; the cube icon is drawn by CSS (mask + currentColor) so it follows the button's theme colours.
 */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function deviceEnv(): DeviceEnv {
  const os = detectOs(navigator.userAgent, navigator.maxTouchPoints);
  if (os !== 'ios') return { os };
  const rel = document.createElement('a').relList as DOMTokenList | undefined;
  return { os, quickLookSupported: typeof rel?.supports === 'function' && rel.supports('ar') };
}

const UNAVAILABLE: Record<string, string> = {
  desktop: 'To see it in AR, open this page on an iPhone, iPad or Android phone (sign in with the same account).',
  'no-quick-look': 'AR Quick Look is not available in this browser. Open this page in Safari to see the object in AR.',
  'needs-https': 'AR viewers can only open files from an HTTPS site, so “View in AR” is not available here.',
  'missing-file': 'The file for this phone is not ready.',
};

/** "View in AR" for a finished conversion: Quick Look on iOS, Scene Viewer (floor) on Android (ADR-026). */
export function ViewInAr({ conversion: c, title }: { conversion: ConversionSummary; title: string }) {
  const [params] = useSearchParams();
  const env = useMemo(deviceEnv, []);
  const launch = viewInAr(env, {
    usdzUrl: c.outputs.usdz?.contentUrl ?? null,
    glbUrl: c.outputs.glb?.contentUrl ?? null,
    fallbackUrl: fallbackUrl(),
    title,
  });
  return (
    <div className={styles.viewInAr} data-testid="view-in-ar">
      {params.get('ar') === 'unavailable' && (
        <Alert tone="error">Scene Viewer could not start on this phone. It needs the Google app and Google Play Services for AR (ARCore).</Alert>
      )}
      {launch.kind === 'unavailable' ? (
        <p className={formStyles.hint} data-testid="view-in-ar-unavailable" data-reason={launch.reason}>
          {UNAVAILABLE[launch.reason]}
        </p>
      ) : (
        <a
          className={cx(formStyles.button, styles.download)}
          href={launch.href}
          {...(launch.kind === 'quick-look' ? { rel: 'ar' } : {})}
          data-viewer={launch.kind}
        >
          <img src={PIXEL} alt="" width={20} height={20} className={styles.arIcon} />
          View in AR
        </a>
      )}
    </div>
  );
}

function fallbackUrl(): string {
  const u = new URL(window.location.href);
  u.searchParams.set('ar', 'unavailable');
  u.hash = '';
  return u.href;
}

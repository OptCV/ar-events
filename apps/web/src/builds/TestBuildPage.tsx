import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { buildQuickLookHref, buildSceneViewerIntent, detectOs, onQuickLookTap, type DeviceEnv } from '@ar-creator/platform-launch';
import type { TestBuildResponse } from '@ar-creator/contracts';
import { ApiRequestError } from '../api/client.ts';
import { cx } from '../components/cx.ts';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { usePublicExperience, useTestBuild } from './api.ts';
import { linkKind, tracker, type Track } from './track.ts';
import { QrCode } from './QrCode.tsx';
import styles from './Builds.module.css';

const ModelPreview = lazy(() => import('../imageObjects/ModelPreview.tsx'));
/** three.js + WebXR load only for Android image placement. */
const ImageViewer = lazy(() => import('./xr/ImageViewer.tsx'));
/** Quick Look opens only from `<a rel="ar">` whose first child is an image. */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function deviceEnv(): DeviceEnv {
  const os = detectOs(navigator.userAgent, navigator.maxTouchPoints);
  if (os !== 'ios') return { os };
  const rel = document.createElement('a').relList as DOMTokenList | undefined;
  return { os, quickLookSupported: typeof rel?.supports === 'function' && rel.supports('ar') };
}

/**
 * Public device test page (Phase 5 M16, ADR-034). Opened from the signed test link; no sign-in. Routes per
 * PLATFORM_ROUTING.md: iPhone → AR Quick Look (main button as the banner, handled here), Android floor/wall → Scene
 * Viewer (main button as `link`), Android image → the experimental WebXR image viewer (M17), desktop → 3D preview
 * and a QR code.
 * Every link of the experience is listed below on every device (ADR-031).
 */
export function TestBuildPage() {
  const { id = '' } = useParams();
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const signed = new URLSearchParams([...params].filter(([k]) => k === 'v' || k === 'exp' || k === 'sig'));
  const q = useTestBuild(id, `?${signed}`);
  const env = useMemo(deviceEnv, []);

  if (q.isPending) return <p role="status">Loading the test…</p>;
  if (q.isError) {
    const e = q.error instanceof ApiRequestError ? q.error : null;
    return (
      <section className={styles.page}>
        <h1>{e?.status === 403 ? 'This test link no longer works' : 'Test not found'}</h1>
        <p>{e?.status === 403 ? e.message : 'The test build may have been replaced by a newer one. Make a new link in the editor.'}</p>
      </section>
    );
  }
  return <ExperienceViewer t={q.data} env={env} fallbackParam={params.get('ar')} />;
}

/** Published experience at its stable URL (Phase 6 M18, ADR-036): the same viewer, no expiry, no test badge. */
export function PublicExperiencePage() {
  const { slug = '' } = useParams();
  const { search } = useLocation();
  const q = usePublicExperience(slug);
  const env = useMemo(deviceEnv, []);
  const track = useMemo(() => tracker(slug), [slug]);
  if (q.isPending) return <p role="status">Loading…</p>;
  if (q.isError) {
    return (
      <section className={styles.page}>
        <h1>Experience not available</h1>
        <p>It may have been unpublished, or the link is wrong.</p>
      </section>
    );
  }
  return <ExperienceViewer t={q.data} env={env} fallbackParam={new URLSearchParams(search).get('ar')} track={track} slug={slug} />;
}

/** `track`: published pages only (test pages are never counted). */
function ExperienceViewer({ t, env, fallbackParam, track, slug }: { t: TestBuildResponse; env: DeviceEnv; fallbackParam: string | null; track?: Track; slug?: string }) {
  const [shared, setShared] = useState<string | null>(null);
  useEffect(() => {
    const before = document.title;
    document.title = t.name;
    return () => {
      document.title = before;
    };
  }, [t.name]);
  // One visit per browser tab (remembered locally for the tab only; nothing about the visitor is sent).
  useEffect(() => {
    if (!track || !slug) return;
    const key = `ar-creator:viewed:${slug}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      // Storage unavailable (private mode): count this page load.
    }
    track({ event: 'view', detail: env.os === 'other' ? 'desktop' : env.os });
  }, [track, slug, env.os]);
  const share = async () => {
    const url = window.location.href.replace(/[?#].*$/, '');
    try {
      if (navigator.share) await navigator.share({ title: t.name, url });
      else {
        await navigator.clipboard.writeText(url);
        setShared('Link copied.');
      }
    } catch {
      // The visitor closed the share sheet.
    }
  };
  return (
    <section className={styles.page} data-testid={t.mode === 'test' ? 'test-page' : 'public-page'} data-os={env.os}>
      {t.mode === 'test' && <p className={styles.badge}>Test build — not published</p>}
      <h1>{t.name}</h1>
      {t.description && <p className={styles.description}>{t.description}</p>}
      {fallbackParam === 'unavailable' && <Alert tone="error">Scene Viewer could not start on this phone. It needs the Google app and Google Play Services for AR (ARCore).</Alert>}
      <Launch t={t} env={env} {...(track ? { track } : {})} />
      {t.tracking && (
        <div className={styles.tracking} data-testid="tracking-print">
          <h2>Print the tracking image</h2>
          <p>
            Print it so the image is exactly <strong>{Number((t.tracking.widthMeters * 100).toFixed(1))} cm</strong> wide, then point the camera at it.
          </p>
          <a href={t.tracking.imageUrl} target="_blank" rel="noreferrer">
            <img src={t.tracking.imageUrl} alt="The tracking image to print" className={styles.trackingImage} />
          </a>
          {slug && (
            <a href={`/x/${slug}/print`} className={cx(formStyles.button, formStyles.secondary, styles.linkButton)} data-testid="print-sheet">
              Print sheet (exact size)
            </a>
          )}
        </div>
      )}
      {t.links.length > 0 && (
        <nav className={styles.links} aria-label="Links">
          {t.links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={cx(formStyles.button, !l.primary && formStyles.secondary, styles.linkButton)}
              data-testid="page-link"
              onClick={() => track?.({ event: 'link_tap', detail: linkKind(l.href) })}
              {...(l.href.startsWith('https:') ? { rel: 'noreferrer' } : {})}
            >
              {l.label}
            </a>
          ))}
        </nav>
      )}
      {t.mode === 'public' && (
        <div className={styles.share}>
          <button type="button" className={cx(formStyles.button, formStyles.secondary)} onClick={() => void share()} data-testid="share">
            Share
          </button>
          {shared && <span role="status">{shared}</span>}
        </div>
      )}
      {t.mode === 'test' && t.linkExpiresAt && (
        <p className={formStyles.hint}>This link works until {new Date(t.linkExpiresAt).toLocaleString()}. How the files look in AR is what this test is for: nothing here has been confirmed on a device yet.</p>
      )}
    </section>
  );
}

function Launch({ t, env, track }: { t: TestBuildResponse; env: DeviceEnv; track?: Track }) {
  const anchor = useRef<HTMLAnchorElement>(null);
  // Quick Look's banner tap arrives as a message on the launching anchor; the page opens the main link (ADR-031).
  useEffect(() => {
    if (!anchor.current || !t.primary) return;
    return onQuickLookTap(anchor.current, t.primary.url, (url) => {
      track?.({ event: 'link_tap', detail: 'web' });
      window.location.assign(url);
    });
  }, [t.primary, t.usdzUrl, track]);

  if (env.os === 'ios') {
    if (!t.usdzUrl) return <Alert tone="error">The iPhone file could not be made: {t.unavailable.ios ?? 'unknown reason'}</Alert>;
    if (env.quickLookSupported === false) return <Alert tone="error">AR Quick Look is not available in this browser. Open this page in Safari.</Alert>;
    let href: string;
    try {
      href = buildQuickLookHref({ usdzUrl: t.usdzUrl, ...(t.primary ? { callToAction: t.primary.label } : {}) });
    } catch {
      return <Alert tone="error">AR viewers can only open files from an HTTPS site.</Alert>;
    }
    return (
      <a ref={anchor} rel="ar" href={href} className={cx(formStyles.button, styles.launch)} data-testid="launch" data-viewer="quick-look" onClick={() => track?.({ event: 'ar_tap', detail: `ios_quicklook_${t.placementMode}` })}>
        <img src={PIXEL} alt="" width={1} height={1} />
        View in AR
      </a>
    );
  }
  if (env.os === 'android') {
    if (t.placementMode === 'image') {
      if (!t.glbUrl) return <Alert tone="error">The Android file could not be made: {t.unavailable.android ?? 'unknown reason'}</Alert>;
      return (
        <Suspense fallback={<p role="status">Loading the AR viewer…</p>}>
          <ImageViewer t={t} {...(track ? { track } : {})} />
        </Suspense>
      );
    }
    if (!t.glbUrl) return <Alert tone="error">The Android file could not be made: {t.unavailable.android ?? 'unknown reason'}</Alert>;
    const fallback = new URL(window.location.href);
    fallback.searchParams.set('ar', 'unavailable');
    let href: string | null = null;
    try {
      href = buildSceneViewerIntent({ placement: t.placementMode, fileUrl: t.glbUrl, browserFallbackUrl: fallback.href, title: t.name, ...(t.primary ? { link: t.primary.url } : {}) });
    } catch {
      href = null;
    }
    if (!href) return <Alert tone="error">AR viewers can only open files from an HTTPS site.</Alert>;
    return (
      <a href={href} className={cx(formStyles.button, styles.launch)} data-testid="launch" data-viewer="scene-viewer" onClick={() => track?.({ event: 'ar_tap', detail: `android_scene_viewer_${t.placementMode as 'floor' | 'wall'}` })}>
        View in AR
      </a>
    );
  }
  return (
    <div className={styles.desktop} data-testid="desktop">
      <div>
        <QrCode value={window.location.href} size={180} label="QR code of this page: scan it with your phone's camera" />
        <p className={formStyles.hint}>Open this page on an iPhone, iPad or Android phone to see it in AR.</p>
      </div>
      <Preview t={t} />
    </div>
  );
}

function Preview({ t }: { t: TestBuildResponse }) {
  if (!t.glbUrl) return <p className={formStyles.hint}>No 3D preview: {t.unavailable.android ?? 'the GLB is not available'}.</p>;
  return (
    <div className={styles.preview}>
      <Suspense fallback={<p role="status">Loading 3D preview…</p>}>
        <ModelPreview url={t.glbUrl} backdrop="light" label={`3D preview of ${t.name}. Drag to rotate, scroll to zoom.`} />
      </Suspense>
    </div>
  );
}

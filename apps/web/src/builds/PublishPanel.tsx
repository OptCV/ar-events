import { useState } from 'react';
import { ApiRequestError } from '../api/client.ts';
import { cx } from '../components/cx.ts';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { useAnalytics, usePublication, usePublish } from './api.ts';
import type { AnalyticsSummary } from '@ar-creator/contracts';
import { QrCode } from './QrCode.tsx';
import styles from './Builds.module.css';

/**
 * Publish (Phase 6 M18, ADR-036). The public URL is stable. Publishing promotes a complete build of the saved draft;
 * if the draft has no complete build yet it is built first, and the live version only changes when every file is
 * ready — a failed build never replaces what visitors see.
 */
export function PublishPanel({ experienceId, saved }: { experienceId: string; saved: boolean }) {
  const q = usePublication(experienceId);
  const publish = usePublish(experienceId, 'publish');
  const unpublish = usePublish(experienceId, 'unpublish');
  const [copied, setCopied] = useState(false);
  const p = q.data;
  const stats = useAnalytics(experienceId, !!p?.live);
  const error = (publish.error ?? unpublish.error) instanceof ApiRequestError ? ((publish.error ?? unpublish.error) as ApiRequestError) : null;
  const busy = publish.isPending || unpublish.isPending || p?.state === 'publishing';

  return (
    <section className={styles.panel} aria-labelledby="publish-h" data-testid="publish" data-state={p?.state}>
      <h2 id="publish-h">Publish</h2>
      {!p ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          <p role="status" aria-live="polite" className={styles.stateLine}>
            {p.state === 'unpublished'
              ? 'Not published. Visitors cannot open it yet.'
              : p.state === 'publishing'
                ? `Publishing… building the files${p.live ? '; the current version stays live until they are ready' : ''}.`
                : p.upToDate
                  ? 'Published and up to date.'
                  : 'Published. The draft has changes that are not published yet.'}
          </p>
          {p.lastFailure && p.state !== 'publishing' && <Alert tone="error">{p.lastFailure.message}</Alert>}
          {error && (
            <Alert tone="error">
              {error.message}
              {error.issues?.length ? ` ${error.issues.map((i) => i.message).join(' ')}` : ''}
            </Alert>
          )}
          {p.live && (
            <div className={styles.link}>
              <QrCode value={p.url} size={140} label="QR code of the public link" />
              <div className={styles.linkText}>
                <a href={p.url} target="_blank" rel="noreferrer" data-testid="public-link">
                  {p.url}
                </a>
                <p className={formStyles.hint}>Version {p.live.revisionNumber}. This address stays the same when you publish changes.</p>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => {
                    void navigator.clipboard?.writeText(p.url).then(() => setCopied(true));
                  }}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </div>
          )}
          <div className={styles.actionsRow}>
            {(!p.live || !p.upToDate) && (
              <button type="button" className={formStyles.button} disabled={busy || !saved} onClick={() => publish.mutate()}>
                {p.state === 'publishing' ? 'Publishing…' : p.live ? 'Publish changes' : 'Publish'}
              </button>
            )}
            {p.live && (
              <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={busy} onClick={() => unpublish.mutate()}>
                Unpublish
              </button>
            )}
          </div>
          {p.live && stats.data && <Visits a={stats.data} />}
          {!saved && <p className={formStyles.hint}>Publishing uses the saved draft; wait until your changes are saved.</p>}
        </>
      )}
    </section>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Last 30 days, anonymous counts only. AR taps are taps on the AR button, not confirmed AR sessions. */
function Visits({ a }: { a: AnalyticsSummary }) {
  return (
    <div className={styles.visits} data-testid="visits">
      <h3 className={styles.visitsTitle}>Last {a.days} days</h3>
      <p>
        {plural(a.totals.views, 'visit', 'visits')} ({a.views.ios} iPhone/iPad · {a.views.android} Android · {a.views.desktop} computer)
      </p>
      <p>
        {plural(a.totals.arTaps, 'AR button tap', 'AR button taps')} ({a.arTaps.quickLook} Quick Look · {a.arTaps.sceneViewer} Scene Viewer · {a.arTaps.webxr} image tracking) · {plural(a.totals.linkTaps, 'link tap', 'link taps')}
      </p>
      <p className={formStyles.hint}>Anonymous counts only; nothing about visitors is stored. A tap on the AR button does not confirm that AR started.</p>
    </div>
  );
}

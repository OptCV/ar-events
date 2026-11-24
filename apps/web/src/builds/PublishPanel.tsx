import { useState } from 'react';
import { ApiRequestError } from '../api/client.ts';
import { cx } from '../components/cx.ts';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { usePublication, usePublish } from './api.ts';
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
          {!saved && <p className={formStyles.hint}>Publishing uses the saved draft; wait until your changes are saved.</p>}
        </>
      )}
    </section>
  );
}

import { useState } from 'react';
import { formatBytes, type BuildSummary } from '@ar-creator/contracts';
import { ApiRequestError } from '../api/client.ts';
import { cx } from '../components/cx.ts';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { useLatestBuild, useStartBuild } from './api.ts';
import { QrCode } from './QrCode.tsx';
import styles from './Builds.module.css';

const STATE_TEXT: Record<BuildSummary['state'], string> = {
  queued: 'Waiting to start…',
  compiling: 'Building the iPhone and Android files…',
  ready: 'Ready to test on your phones.',
  partially_ready: 'Ready on one platform only.',
  failed: 'The test build failed.',
};
const PLATFORM = { ios: 'iPhone and iPad (USDZ)', android: 'Android (GLB)' } as const;
const size = (b: number | null) => (b === null ? '' : ` · ${formatBytes(b)}`);

/**
 * "Test on device" (Phase 5 M16, ADR-034): build the saved draft into the real AR files and open them on a phone with a
 * short-lived link (QR code). Nothing here is publishing; the link stops working after 24 hours or when a newer build
 * replaces this one.
 */
export function TestOnDevice({ experienceId, saved }: { experienceId: string; saved: boolean }) {
  const q = useLatestBuild(experienceId);
  const start = useStartBuild(experienceId);
  const [copied, setCopied] = useState(false);
  const b = q.data ?? null;
  const busy = start.isPending || b?.state === 'queued' || b?.state === 'compiling';
  const error = start.error instanceof ApiRequestError ? start.error : null;

  return (
    <section className={styles.panel} aria-labelledby="test-h" data-testid="test-on-device">
      <h2 id="test-h">Test on device</h2>
      <p className={formStyles.hint}>Builds the real iPhone and Android files from the saved draft, with a link for your phones. It is not published.</p>
      {error && (
        <Alert tone="error">
          {error.message}
          {error.issues?.length ? ` ${error.issues.map((i) => i.message).join(' ')}` : ''}
        </Alert>
      )}
      {b && (
        <div className={styles.status} data-testid="build-status" data-state={b.state}>
          <p role="status" aria-live="polite" className={styles.stateLine}>
            {STATE_TEXT[b.state]}
            {!b.current && b.state !== 'queued' && b.state !== 'compiling' && <span className={styles.stale}> The draft has changed since this build.</span>}
          </p>
          {b.error && <Alert tone="error">{b.error.message}</Alert>}
          <ul className={styles.outputs}>
            {b.outputs.map((o) => (
              <li key={o.id} data-testid={`build-output-${o.platform}`}>
                <span className={cx(styles.dot, styles[`dot_${o.state}`])} aria-hidden="true" />
                <span>
                  {PLATFORM[o.platform]}: {o.state === 'ready' ? `ready${size(o.sizeBytes)}` : o.state === 'failed' ? `not available — ${o.error?.message ?? 'failed'}` : 'building…'}
                  {o.warnings.map((w) => (
                    <span key={w} className={styles.warning}>
                      {w}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          {b.testUrl && (
            <div className={styles.link}>
              <QrCode value={b.testUrl} size={168} label="QR code of the test link: scan it with your phone's camera" />
              <div className={styles.linkText}>
                <p className={formStyles.hint}>Scan with your phone's camera, or open the link on the phone. Anyone with the link can view this test until {new Date(b.testUrlExpiresAt!).toLocaleString()}.</p>
                <a href={b.testUrl} target="_blank" rel="noreferrer" data-testid="test-link">
                  Open the test page
                </a>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => {
                    void navigator.clipboard?.writeText(b.testUrl!).then(() => setCopied(true));
                  }}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {(!b || !b.current || b.state === 'failed') && (
      <button
        type="button"
        className={formStyles.button}
        disabled={busy || !saved}
        onClick={() => {
          setCopied(false);
          start.mutate();
        }}
      >
        {busy ? 'Building…' : b ? (b.state === 'failed' && b.current ? 'Try again' : 'Build the latest draft') : 'Make a test build'}
      </button>
      )}
      {!saved && <p className={formStyles.hint}>Builds use the saved draft; wait until your changes are saved.</p>}
    </section>
  );
}

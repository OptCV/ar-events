import { useHealth } from '../api/health.ts';
import { cx } from '../components/cx.ts';
import styles from './HomePage.module.css';

const MODES = [
  { name: 'Image anchored', ios: 'AR Quick Look (image anchor)', android: 'Chrome WebXR image tracking — experimental' },
  { name: 'Floor', ios: 'AR Quick Look (horizontal plane)', android: 'Google Scene Viewer' },
  { name: 'Wall', ios: 'AR Quick Look (vertical plane)', android: 'Google Scene Viewer (vertical placement)' },
] as const;

export function HomePage() {
  return (
    <>
      <section className={styles.hero} aria-labelledby="home-title">
        <h1 id="home-title">Create and publish AR experiences</h1>
        <p className={styles.lead}>
          Build image, floor and wall AR scenes and share them with one link. The creator workspace is under construction; sign-in and
          experience editing arrive in upcoming milestones.
        </p>
      </section>

      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="modes-title">
          <h2 id="modes-title">Placement modes</h2>
          <table className={styles.table}>
            <caption className={styles.caption}>How each placement opens on phones</caption>
            <thead>
              <tr>
                <th scope="col">Mode</th>
                <th scope="col">iPhone / iPad</th>
                <th scope="col">Android</th>
              </tr>
            </thead>
            <tbody>
              {MODES.map((m) => (
                <tr key={m.name}>
                  <th scope="row">{m.name}</th>
                  <td>{m.ios}</td>
                  <td>{m.android}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <SystemStatus />
      </div>
    </>
  );
}

function SystemStatus() {
  const health = useHealth();
  let badge: { tone: 'ok' | 'bad' | 'pending'; label: string };
  if (health.isPending) badge = { tone: 'pending', label: 'Checking…' };
  else if (health.isError) badge = { tone: 'bad', label: 'Unavailable' };
  else badge = { tone: 'ok', label: 'Operational' };

  return (
    <section className={styles.card} aria-labelledby="status-title" data-testid="system-status">
      <h2 id="status-title">System status</h2>
      <p>
        API:{' '}
        <span className={cx(styles.badge, styles[badge.tone])} role="status" aria-live="polite">
          {badge.label}
        </span>
      </p>
      {health.isError && <p className={styles.error}>{health.error.message}</p>}
      {health.data && (
        <dl className={styles.meta}>
          <dt>Version</dt>
          <dd>{health.data.version}</dd>
          <dt>Build</dt>
          <dd>
            <code>{health.data.build}</code>
          </dd>
          <dt>Runtime</dt>
          <dd>{health.data.runtime}</dd>
        </dl>
      )}
    </section>
  );
}

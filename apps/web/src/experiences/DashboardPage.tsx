import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ExperienceSummary } from '@ar-creator/contracts';
import { Alert } from '../components/form/Alert.tsx';
import { cx } from '../components/cx.ts';
import formStyles from '../components/form/Form.module.css';
import { useExperiences } from './api.ts';
import { PLACEMENTS } from './PlacementSelector.tsx';
import styles from './Experiences.module.css';

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86_400), 'day');
}

const STATUS: Record<ExperienceSummary['visibility'], string> = { draft: 'Draft', private_test: 'Private test', public: 'Public' };

export function DashboardPage() {
  const q = useExperiences();
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (q.data ?? []).filter((e) => !term || e.name.toLowerCase().includes(term) || e.slug.includes(term));
  }, [q.data, search]);

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Your experiences</h1>
        <Link to="/experiences/new" className={styles.linkButton}>
          New experience
        </Link>
      </div>

      {q.isPending && (
        <p role="status" aria-live="polite">
          Loading your experiences…
        </p>
      )}
      {q.isError && (
        <div className={styles.section}>
          <Alert tone="error">{q.error.message}</Alert>
          <button type="button" className={cx(formStyles.button, formStyles.secondary)} onClick={() => void q.refetch()}>
            Try again
          </button>
        </div>
      )}

      {q.data && q.data.length === 0 && (
        <section className={styles.empty} aria-labelledby="empty-title">
          <h2 id="empty-title">Create your first AR experience</h2>
          <p>Choose image, floor or wall placement, then add content. You can change the placement later.</p>
          <Link to="/experiences/new" className={styles.linkButton}>
            New experience
          </Link>
        </section>
      )}

      {q.data && q.data.length > 0 && (
        <>
          <div className={styles.toolbar}>
            <label htmlFor="exp-search" className="visually-hidden">
              Search experiences
            </label>
            <input
              id="exp-search"
              className={styles.search}
              type="search"
              placeholder="Search experiences"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className={styles.status} role="status" aria-live="polite">
              {filtered.length} of {q.data.length}
            </span>
          </div>
          <ul className={styles.grid} aria-label="Experiences">
            {filtered.map((e) => (
              <li key={e.id}>
                <Link to={`/experiences/${e.id}`} className={styles.card}>
                  <span className={styles.cardTitle}>{e.name}</span>
                  <span className={styles.meta}>
                    <span className={styles.chip}>{PLACEMENTS[e.placementMode].title}</span>
                    <span className={cx(styles.chip, e.published && styles.chipPublished)}>{e.published ? 'Published' : STATUS[e.visibility]}</span>
                  </span>
                  <span className={styles.meta}>Updated {relativeTime(e.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
          {filtered.length === 0 && <p>No experiences match “{search}”.</p>}
        </>
      )}
    </>
  );
}

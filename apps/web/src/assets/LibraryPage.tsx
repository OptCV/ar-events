import { useState } from 'react';
import { ROLE_POLICY, UPLOADABLE_ROLES, formatBytes, type AssetSummary, type UploadableRole } from '@ar-creator/contracts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { cx } from '../components/cx.ts';
import { Alert } from '../components/form/Alert.tsx';
import expStyles from '../experiences/Experiences.module.css';
import { useAssets, useDeleteAsset } from './api.ts';
import { AssetCard } from './AssetCard.tsx';
import { AssetUploader } from './AssetUploader.tsx';
import styles from './Assets.module.css';

type Filter = UploadableRole | 'all';
const FILTER_LABEL: Record<Filter, string> = { all: 'All', 'tracking-image': 'Tracking images', 'display-image': 'Display images', model: '3D models' };

/** Asset library: upload with an explicit role, browse with previews, delete (Milestone 5). */
export function LibraryPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [role, setRole] = useState<UploadableRole>('tracking-image');
  const q = useAssets(filter === 'all' ? undefined : filter);
  const del = useDeleteAsset();
  const [confirm, setConfirm] = useState<AssetSummary | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);

  return (
    <>
      <div className={expStyles.pageHeader}>
        <h1>Asset library</h1>
        {q.data && (
          <span className={expStyles.status} data-testid="usage">
            {formatBytes(q.data.usage.bytes)} of {formatBytes(q.data.usage.quotaBytes)} used
          </span>
        )}
      </div>

      <section className={cx(expStyles.section, styles.uploadSection)} aria-labelledby="upload-h">
        <h2 id="upload-h">Upload</h2>
        <fieldset className={styles.roles}>
          <legend className={expStyles.legend}>What is this file for?</legend>
          {UPLOADABLE_ROLES.map((r) => (
            <label key={r} className={cx(styles.role, role === r && styles.roleSelected)}>
              <input type="radio" name="upload-role" className={expStyles.radio} value={r} checked={role === r} onChange={() => setRole(r)} />
              {ROLE_POLICY[r].label}
            </label>
          ))}
        </fieldset>
        <AssetUploader key={role} role={role} />
      </section>

      <div className={expStyles.toolbar} role="group" aria-label="Filter assets">
        {(['all', ...UPLOADABLE_ROLES] as const).map((f) => (
          <button key={f} type="button" className={cx(styles.filter, filter === f && styles.filterActive)} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>

      {q.isPending && <p role="status">Loading assets…</p>}
      {q.isError && <Alert tone="error">{q.error.message}</Alert>}
      {q.data && q.data.assets.length === 0 && (
        <div className={expStyles.empty}>
          <h2>No assets yet</h2>
          <p>Upload a tracking image, a display image or a 3D model to use in your experiences.</p>
        </div>
      )}
      {q.data && q.data.assets.length > 0 && (
        <ul className={styles.grid} aria-label="Assets">
          {q.data.assets.map((a) => (
            <AssetCard key={a.id} asset={a} error={deleteError?.id === a.id ? deleteError.message : undefined} onDelete={() => setConfirm(a)} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirm !== null}
        danger
        title={confirm ? `Delete “${confirm.filename ?? 'asset'}”?` : ''}
        confirmLabel="Delete permanently"
        busyLabel="Deleting…"
        busy={del.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          setDeleteError(null);
          try {
            await del.mutateAsync(confirm.id);
          } catch (e) {
            setDeleteError({ id: confirm.id, message: e instanceof Error ? e.message : 'Could not delete.' });
          }
          setConfirm(null);
        }}
      >
        <p>The file is removed from storage. This cannot be undone.</p>
      </ConfirmDialog>
    </>
  );
}

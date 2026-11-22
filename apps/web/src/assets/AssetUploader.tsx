import { useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ROLE_POLICY, formatBytes, type AssetSummary, type UploadableRole } from '@ar-creator/contracts';
import { cx } from '../components/cx.ts';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { invalidateAssets } from './api.ts';
import { uploadAsset, type UploadProgress } from './upload.ts';
import styles from './Assets.module.css';

const HINT: Record<UploadableRole, string> = {
  'tracking-image': 'The printed picture the camera recognises. PNG or JPEG, at least 256 px on the shortest side; detailed, high-contrast images track best.',
  'display-image': 'A picture shown in the AR scene. PNG (transparency kept) or JPEG.',
  model: 'A self-contained binary glTF (.glb) file. External textures or URLs are not allowed.',
};

type State = { kind: 'idle' } | { kind: 'busy'; file: string; progress: UploadProgress } | { kind: 'error'; message: string } | { kind: 'done'; asset: AssetSummary };

export function AssetUploader({ role, onUploaded, compact = false }: { role: UploadableRole; onUploaded?: (a: AssetSummary) => void; compact?: boolean }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const qc = useQueryClient();
  const policy = ROLE_POLICY[role];
  const busy = state.kind === 'busy';

  const start = async (file: File | undefined) => {
    if (!file || busy) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setState({ kind: 'busy', file: file.name, progress: { phase: 'checking', fraction: 0 } });
    try {
      const asset = await uploadAsset(file, role, { signal: ctrl.signal, onProgress: (progress) => setState({ kind: 'busy', file: file.name, progress }) });
      setState({ kind: 'done', asset });
      await invalidateAssets(qc);
      onUploaded?.(asset);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') setState({ kind: 'idle' });
      else setState({ kind: 'error', message: e instanceof Error ? e.message : 'The upload failed.' });
      void invalidateAssets(qc);
    } finally {
      abort.current = null;
      if (input.current) input.current.value = '';
    }
  };

  const phaseText = (p: UploadProgress) =>
    p.phase === 'checking' ? 'Preparing…' : p.phase === 'processing' ? 'Checking the file…' : `Uploading… ${Math.round(p.fraction * 100)}%`;

  return (
    <div
      className={cx(styles.dropzone, dragging && styles.dragging, compact && styles.compact)}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void start(e.dataTransfer.files[0]);
      }}
      data-testid={`uploader-${role}`}
    >
      <input ref={input} id={id} type="file" className="visually-hidden" accept={policy.accept} disabled={busy} onChange={(e) => void start(e.target.files?.[0])} />
      {!compact && <p className={styles.hint}>{HINT[role]}</p>}
      <div className={styles.uploadRow}>
        <label htmlFor={id} className={cx(formStyles.button, styles.fileButton, busy && styles.disabled)} aria-disabled={busy}>
          Choose {policy.label.toLowerCase().replace(' (glb)', '')}
        </label>
        <span className={styles.hint}>or drop it here · up to {formatBytes(policy.maxBytes)}</span>
      </div>
      {state.kind === 'busy' && (
        <div className={styles.progress} role="status" aria-live="polite">
          <span className={styles.fileName}>{state.file}</span>
          <progress max={1} value={state.progress.phase === 'uploading' ? state.progress.fraction : undefined} aria-label={`Upload progress for ${state.file}`} />
          <span>{phaseText(state.progress)}</span>
          <button type="button" className={cx(formStyles.button, formStyles.secondary)} onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </div>
      )}
      {state.kind === 'error' && <Alert tone="error">{state.message}</Alert>}
      {state.kind === 'done' && (
        <Alert tone="success">
          Uploaded {state.asset.filename}
          {state.asset.warnings.length > 0 ? ` — ${state.asset.warnings.join(' ')}` : '.'}
        </Alert>
      )}
    </div>
  );
}

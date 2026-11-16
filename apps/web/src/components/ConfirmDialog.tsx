import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cx } from './cx.ts';
import formStyles from './form/Form.module.css';
import styles from './ConfirmDialog.module.css';

interface Props {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Modal confirmation on the native <dialog> (built-in focus trap, Escape to cancel, focus returns on close). */
export function ConfirmDialog({ open, title, children, confirmLabel, busyLabel, busy = false, danger = false, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId} className={styles.title}>
        {title}
      </h2>
      <div className={styles.body}>{children}</div>
      <div className={styles.actions}>
        <button type="button" className={cx(formStyles.button, formStyles.secondary)} onClick={onCancel} disabled={busy} autoFocus>
          Cancel
        </button>
        <button type="button" className={cx(formStyles.button, danger && styles.danger)} onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
          {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

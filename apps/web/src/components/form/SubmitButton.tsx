import type { ReactNode } from 'react';
import { cx } from '../cx.ts';
import styles from './Form.module.css';

export function SubmitButton({ busy, busyLabel, children, secondary = false }: { busy: boolean; busyLabel: string; children: ReactNode; secondary?: boolean }) {
  return (
    <button type="submit" className={cx(styles.button, secondary && styles.secondary)} disabled={busy} aria-busy={busy || undefined}>
      {busy ? busyLabel : children}
    </button>
  );
}

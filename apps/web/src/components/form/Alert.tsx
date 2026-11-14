import type { ReactNode } from 'react';
import { cx } from '../cx.ts';
import styles from './Form.module.css';

const TONE = { error: styles.alertError, info: styles.alertInfo, success: styles.alertSuccess };

/** Errors use role=alert (announced immediately); info/success use role=status. */
export function Alert({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) {
  return (
    <p className={cx(styles.alert, TONE[tone])} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

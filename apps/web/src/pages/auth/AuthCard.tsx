import { useEffect, useRef, type ReactNode } from 'react';
import styles from './Auth.module.css';

/** Centered card for auth pages. Moves focus to the heading on mount so screen readers announce the new page. */
export function AuthCard({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className={styles.card} aria-labelledby="auth-title">
      <h1 id="auth-title" ref={heading} tabIndex={-1} className={styles.title}>
        {title}
      </h1>
      {intro && <div className={styles.intro}>{intro}</div>}
      {children}
      {footer && <div className={styles.footer}>{footer}</div>}
    </section>
  );
}

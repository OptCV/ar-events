import { NavLink, Outlet } from 'react-router';
import { cx } from './cx.ts';
import styles from './AppLayout.module.css';

export function AppLayout() {
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <NavLink to="/" className={cx(styles.brand)} aria-label="AR Creator home">
            <span className={styles.logo} aria-hidden="true" />
            AR Creator
          </NavLink>
          <nav aria-label="Primary">
            <NavLink to="/" end className={({ isActive }) => cx(styles.navLink, isActive && styles.active)}>
              Home
            </NavLink>
          </nav>
        </div>
      </header>
      <main id="main" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

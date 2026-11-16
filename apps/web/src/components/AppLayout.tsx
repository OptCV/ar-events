import { NavLink, Outlet } from 'react-router';
import { useSession, useSignOut } from '../auth/session.tsx';
import { cx } from './cx.ts';
import styles from './AppLayout.module.css';

const navClass = ({ isActive }: { isActive: boolean }) => cx(styles.navLink, isActive && styles.active);

export function AppLayout() {
  const { user, isLoading } = useSession();
  const signOut = useSignOut();
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
          <nav aria-label="Primary" className={styles.nav}>
            <NavLink to="/" end className={navClass}>
              Home
            </NavLink>
            {!isLoading && user && (
              <>
                <NavLink to="/dashboard" className={navClass}>
                  Dashboard
                </NavLink>
                <NavLink to="/account" className={navClass}>
                  Account
                </NavLink>
                <button type="button" className={styles.navButton} onClick={() => signOut.mutate()} disabled={signOut.isPending}>
                  {signOut.isPending ? 'Signing out…' : 'Sign out'}
                </button>
              </>
            )}
            {!isLoading && !user && (
              <NavLink to="/sign-in" className={navClass}>
                Sign in
              </NavLink>
            )}
          </nav>
        </div>
      </header>
      <main id="main" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

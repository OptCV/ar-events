import { useSession, useSignOut } from '../auth/session.tsx';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { cx } from '../components/cx.ts';
import styles from './auth/Auth.module.css';
import { AuthCard } from './auth/AuthCard.tsx';

/** Protected page (behind RequireAuth). Milestone 4 replaces this with the dashboard. */
export function AccountPage() {
  const { user } = useSession();
  const signOut = useSignOut(false);
  const signOutAll = useSignOut(true);
  if (!user) return null;
  const busy = signOut.isPending || signOutAll.isPending;
  return (
    <AuthCard title="Your account">
      <dl className={styles.details}>
        <dt>Name</dt>
        <dd>{user.name}</dd>
        <dt>Email</dt>
        <dd data-testid="account-email">{user.email}</dd>
        <dt>Email confirmed</dt>
        <dd>{user.emailVerified ? 'Yes' : 'No'}</dd>
      </dl>
      {(signOut.isError || signOutAll.isError) && <Alert tone="error">Signing out failed. Please try again.</Alert>}
      <div className={styles.row}>
        <button type="button" className={formStyles.button} disabled={busy} onClick={() => signOut.mutate()}>
          {signOut.isPending ? 'Signing out…' : 'Sign out'}
        </button>
        <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={busy} onClick={() => signOutAll.mutate()}>
          {signOutAll.isPending ? 'Signing out…' : 'Sign out of all devices'}
        </button>
      </div>
    </AuthCard>
  );
}

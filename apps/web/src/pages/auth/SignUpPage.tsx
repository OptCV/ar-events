import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { PASSWORD_MIN_LENGTH, SignUpInput } from '@ar-creator/contracts';
import { AuthError, authApi } from '../../auth/api.ts';
import { useAuthConfig, useSession } from '../../auth/session.tsx';
import { Alert } from '../../components/form/Alert.tsx';
import { Field } from '../../components/form/Field.tsx';
import formStyles from '../../components/form/Form.module.css';
import { SubmitButton } from '../../components/form/SubmitButton.tsx';
import { useZodForm } from '../../components/form/useZodForm.ts';
import { AuthCard } from './AuthCard.tsx';

export function SignUpPage() {
  const config = useAuthConfig();
  const { user } = useSession();
  const navigate = useNavigate();
  const form = useZodForm(SignUpInput, { name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to="/account" replace />;
  if (config.isPending) {
    return (
      <AuthCard title="Create your account">
        <p role="status">Loading…</p>
      </AuthCard>
    );
  }
  if (!config.data?.signupEnabled) {
    return (
      <AuthCard title="Sign-up is not open yet" footer={<Link to="/sign-in">Already have an account? Sign in</Link>}>
        <Alert tone="info">New accounts are not available yet. Please check back soon.</Alert>
      </AuthCard>
    );
  }

  const onSubmit = form.handleSubmit(async (data) => {
    setBusy(true);
    setError(null);
    try {
      await authApi.signUp(data);
      // Same outcome whether or not the address already had an account (no account enumeration).
      navigate(`/verify-email?email=${encodeURIComponent(data.email)}`, { replace: true });
    } catch (e) {
      setError(e instanceof AuthError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  });

  return (
    <AuthCard
      title="Create your account"
      intro={<p>We will email you a link to confirm your address before you can sign in.</p>}
      footer={
        <p>
          Already have an account? <Link to="/sign-in">Sign in</Link>
        </p>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      <form ref={form.formRef} className={formStyles.form} onSubmit={onSubmit} noValidate>
        <Field label="Name" autoComplete="name" required {...form.bind('name')} />
        <Field label="Email" type="email" autoComplete="email" inputMode="email" required {...form.bind('email')} />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easy to remember and hard to guess.`}
          {...form.bind('password')}
        />
        <SubmitButton busy={busy} busyLabel="Creating account…">
          Create account
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

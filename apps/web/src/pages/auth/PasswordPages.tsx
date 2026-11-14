import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ForgotPasswordInput, PASSWORD_MIN_LENGTH, ResetPasswordInput } from '@ar-creator/contracts';
import { AuthError, authApi } from '../../auth/api.ts';
import { Alert } from '../../components/form/Alert.tsx';
import { Field } from '../../components/form/Field.tsx';
import formStyles from '../../components/form/Form.module.css';
import { SubmitButton } from '../../components/form/SubmitButton.tsx';
import { useZodForm } from '../../components/form/useZodForm.ts';
import { AuthCard } from './AuthCard.tsx';

export function ForgotPasswordPage() {
  const form = useZodForm(ForgotPasswordInput, { email: '' });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = form.handleSubmit(async ({ email }) => {
    setBusy(true);
    setError(null);
    try {
      await authApi.requestPasswordReset(email);
      setSent(true);
    } catch (e) {
      setError(e instanceof AuthError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  });

  if (sent) {
    return (
      <AuthCard title="Check your inbox" footer={<Link to="/sign-in">Back to sign in</Link>}>
        {/* Identical message whether or not the account exists (no account enumeration). */}
        <Alert tone="success">If an account exists for that address, we have sent a link to reset the password. It expires in 1 hour.</Alert>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Reset your password"
      intro={<p>Enter your account email and we will send you a link to choose a new password.</p>}
      footer={<Link to="/sign-in">Back to sign in</Link>}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <form ref={form.formRef} className={formStyles.form} onSubmit={onSubmit} noValidate>
        <Field label="Email" type="email" autoComplete="email" inputMode="email" required {...form.bind('email')} />
        <SubmitButton busy={busy} busyLabel="Sending…">
          Send reset link
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const linkError = params.get('error');
  const navigate = useNavigate();
  const form = useZodForm(ResetPasswordInput, { password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (linkError || !token) {
    return (
      <AuthCard title="This link did not work" footer={<Link to="/sign-in">Back to sign in</Link>}>
        <Alert tone="error">This password reset link is invalid or has expired.</Alert>
        <p>
          <Link to="/forgot-password">Request a new link</Link>
        </p>
      </AuthCard>
    );
  }

  const onSubmit = form.handleSubmit(async ({ password }) => {
    setBusy(true);
    setError(null);
    try {
      await authApi.resetPassword(token, password);
      navigate('/sign-in?reset=1', { replace: true });
    } catch (e) {
      setError(e instanceof AuthError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  });

  return (
    <AuthCard title="Choose a new password" intro={<p>For your security, this signs you out on every device.</p>}>
      {error && <Alert tone="error">{error}</Alert>}
      <form ref={form.formRef} className={formStyles.form} onSubmit={onSubmit} noValidate>
        <Field label="New password" type="password" autoComplete="new-password" required hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} {...form.bind('password')} />
        <Field label="Confirm new password" type="password" autoComplete="new-password" required {...form.bind('confirm')} />
        <SubmitButton busy={busy} busyLabel="Saving…">
          Save new password
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

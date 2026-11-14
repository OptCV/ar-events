import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { SignInInput } from '@ar-creator/contracts';
import { AuthError, authApi, safeNext } from '../../auth/api.ts';
import { SESSION_KEY, useAuthConfig, useSession } from '../../auth/session.tsx';
import { Alert } from '../../components/form/Alert.tsx';
import { Field } from '../../components/form/Field.tsx';
import formStyles from '../../components/form/Form.module.css';
import { SubmitButton } from '../../components/form/SubmitButton.tsx';
import { useZodForm } from '../../components/form/useZodForm.ts';
import { AuthCard } from './AuthCard.tsx';

export function SignInPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useSession();
  const config = useAuthConfig();
  const form = useZodForm(SignInInput, { email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  if (user) return <Navigate to={next} replace />;

  const onSubmit = form.handleSubmit(async (data) => {
    setBusy(true);
    setError(null);
    try {
      await authApi.signIn(data);
      await qc.invalidateQueries({ queryKey: SESSION_KEY });
      navigate(next, { replace: true });
    } catch (e) {
      setError(e instanceof AuthError ? e : new AuthError(0, 'unknown', 'Something went wrong. Please try again.'));
      form.setValues((v) => ({ ...v, password: '' }));
    } finally {
      setBusy(false);
    }
  });

  let notice: { tone: 'info' | 'success'; text: string } | null = null;
  if (params.get('signedOut')) notice = { tone: 'info', text: 'You have been signed out.' };
  if (params.get('reset')) notice = { tone: 'success', text: 'Your password was changed. Sign in with your new password.' };
  if (params.get('verified')) notice = { tone: 'success', text: 'Your email is confirmed. You can sign in now.' };

  return (
    <AuthCard
      title="Sign in"
      footer={
        <>
          <p>
            <Link to="/forgot-password">Forgot your password?</Link>
          </p>
          {config.data?.signupEnabled && (
            <p>
              New to AR Creator? <Link to="/sign-up">Create an account</Link>
            </p>
          )}
        </>
      }
    >
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {error && <Alert tone="error">{error.message}</Alert>}
      <form ref={form.formRef} className={formStyles.form} onSubmit={onSubmit} noValidate>
        <Field label="Email" type="email" autoComplete="email" inputMode="email" required {...form.bind('email')} />
        <Field label="Password" type="password" autoComplete="current-password" required {...form.bind('password')} />
        <SubmitButton busy={busy} busyLabel="Signing in…">
          Sign in
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

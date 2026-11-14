import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ForgotPasswordInput } from '@ar-creator/contracts';
import { AuthError, authApi } from '../../auth/api.ts';
import { Alert } from '../../components/form/Alert.tsx';
import { Field } from '../../components/form/Field.tsx';
import formStyles from '../../components/form/Form.module.css';
import { SubmitButton } from '../../components/form/SubmitButton.tsx';
import { useZodForm } from '../../components/form/useZodForm.ts';
import { AuthCard } from './AuthCard.tsx';

/** Re-send the confirmation email (rate limited server-side: 3 per 15 minutes per IP). */
function ResendVerification({ initialEmail }: { initialEmail: string }) {
  const form = useZodForm(ForgotPasswordInput, { email: initialEmail });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const onSubmit = form.handleSubmit(async ({ email }) => {
    setBusy(true);
    setResult(null);
    try {
      await authApi.resendVerification(email);
      setResult({ tone: 'success', text: 'If that address has an unconfirmed account, a new link is on its way.' });
    } catch (e) {
      setResult({ tone: 'error', text: e instanceof AuthError ? e.message : 'Something went wrong. Please try again.' });
    } finally {
      setBusy(false);
    }
  });
  return (
    <form ref={form.formRef} className={formStyles.form} onSubmit={onSubmit} noValidate aria-label="Resend confirmation email">
      {result && <Alert tone={result.tone}>{result.text}</Alert>}
      <Field label="Email" type="email" autoComplete="email" required {...form.bind('email')} />
      <SubmitButton busy={busy} busyLabel="Sending…" secondary>
        Resend confirmation email
      </SubmitButton>
    </form>
  );
}

/** After sign-up: "check your inbox". */
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const email = params.get('email') ?? '';
  return (
    <AuthCard
      title="Check your inbox"
      intro={
        <p>
          {email ? (
            <>
              If <strong>{email}</strong> can be registered, we have sent it a confirmation link.
            </>
          ) : (
            'We have sent you a confirmation link.'
          )}{' '}
          The link expires in 1 hour.
        </p>
      }
      footer={
        <p>
          Confirmed already? <Link to="/sign-in">Sign in</Link>
        </p>
      }
    >
      <ResendVerification initialEmail={email} />
    </AuthCard>
  );
}

/** Landing page for the email link (Better Auth redirects here, with ?error= on failure). */
export function EmailVerifiedPage() {
  const [params] = useSearchParams();
  const error = params.get('error');
  if (error) {
    return (
      <AuthCard title="This link did not work" intro={<p>The confirmation link is invalid or has expired. Request a new one below.</p>}>
        <ResendVerification initialEmail="" />
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Email confirmed">
      <Alert tone="success">Your email address is confirmed.</Alert>
      <p>
        <Link to="/sign-in?verified=1">Continue to sign in</Link>
      </p>
    </AuthCard>
  );
}

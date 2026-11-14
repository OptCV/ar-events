import { createBrowserRouter } from 'react-router';
import { RequireAuth } from './auth/session.tsx';
import { AppLayout } from './components/AppLayout.tsx';
import { AccountPage } from './pages/AccountPage.tsx';
import { EmailVerifiedPage, VerifyEmailPage } from './pages/auth/EmailPages.tsx';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/auth/PasswordPages.tsx';
import { SignInPage } from './pages/auth/SignInPage.tsx';
import { SignUpPage } from './pages/auth/SignUpPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { RouteErrorPage } from './pages/RouteErrorPage.tsx';

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'sign-in', element: <SignInPage /> },
      { path: 'sign-up', element: <SignUpPage /> },
      { path: 'verify-email', element: <VerifyEmailPage /> },
      { path: 'email-verified', element: <EmailVerifiedPage /> },
      { path: 'forgot-password', element: <ForgotPasswordPage /> },
      { path: 'reset-password', element: <ResetPasswordPage /> },
      // Protected routes: everything under RequireAuth needs a valid server-side session.
      { element: <RequireAuth />, children: [{ path: 'account', element: <AccountPage /> }] },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

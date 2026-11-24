import { createBrowserRouter } from 'react-router';
import { RequireAuth } from './auth/session.tsx';
import { AppLayout } from './components/AppLayout.tsx';
import { AccountPage } from './pages/AccountPage.tsx';
import { DashboardPage } from './experiences/DashboardPage.tsx';
import { ExperiencePage } from './experiences/ExperiencePage.tsx';
import { LibraryPage } from './assets/LibraryPage.tsx';
import { ImageObjectPage } from './imageObjects/ImageObjectPage.tsx';
import { NewExperiencePage } from './experiences/NewExperiencePage.tsx';
import { EmailVerifiedPage, VerifyEmailPage } from './pages/auth/EmailPages.tsx';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/auth/PasswordPages.tsx';
import { SignInPage } from './pages/auth/SignInPage.tsx';
import { SignUpPage } from './pages/auth/SignUpPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { RouteErrorPage } from './pages/RouteErrorPage.tsx';
import { PublicExperiencePage, TestBuildPage } from './builds/TestBuildPage.tsx';
import { PrintSheet } from './builds/PrintSheet.tsx';

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
      // Public device test page: the signed link in the URL is the credential (ADR-034).
      { path: 'test/:id', element: <TestBuildPage /> },
      // Published experiences at their stable public URL (ADR-036).
      { path: 'x/:slug', element: <PublicExperiencePage /> },
      { path: 'x/:slug/print', element: <PrintSheet /> },
      // Protected routes: everything under RequireAuth needs a valid server-side session.
      {
        element: <RequireAuth />,
        children: [
          { path: 'dashboard', element: <DashboardPage /> },
          { path: 'experiences/new', element: <NewExperiencePage /> },
          { path: 'experiences/:id', element: <ExperiencePage /> },
          { path: 'library', element: <LibraryPage /> },
          { path: 'library/:assetId/ar-object', element: <ImageObjectPage /> },
          { path: 'account', element: <AccountPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

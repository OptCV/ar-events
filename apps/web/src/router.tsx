import { createBrowserRouter } from 'react-router';
import { RequireAuth } from './auth/session.tsx';
import { AppLayout } from './components/AppLayout.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { RouteErrorPage } from './pages/RouteErrorPage.tsx';

/**
 * Every page except the shell is its own chunk (Phase 6 M20, ADR-038): a visitor opening a public experience
 * downloads the viewer, not the editor; `npm run check:bundle -w @ar-creator/web` enforces the budgets.
 */
export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'sign-in', lazy: async () => ({ Component: (await import('./pages/auth/SignInPage.tsx')).SignInPage }) },
      { path: 'sign-up', lazy: async () => ({ Component: (await import('./pages/auth/SignUpPage.tsx')).SignUpPage }) },
      { path: 'verify-email', lazy: async () => ({ Component: (await import('./pages/auth/EmailPages.tsx')).VerifyEmailPage }) },
      { path: 'email-verified', lazy: async () => ({ Component: (await import('./pages/auth/EmailPages.tsx')).EmailVerifiedPage }) },
      { path: 'forgot-password', lazy: async () => ({ Component: (await import('./pages/auth/PasswordPages.tsx')).ForgotPasswordPage }) },
      { path: 'reset-password', lazy: async () => ({ Component: (await import('./pages/auth/PasswordPages.tsx')).ResetPasswordPage }) },
      // Public device test page: the signed link in the URL is the credential (ADR-034).
      { path: 'test/:id', lazy: async () => ({ Component: (await import('./builds/TestBuildPage.tsx')).TestBuildPage }) },
      // Published experiences at their stable public URL (ADR-036).
      { path: 'x/:slug', lazy: async () => ({ Component: (await import('./builds/TestBuildPage.tsx')).PublicExperiencePage }) },
      { path: 'x/:slug/print', lazy: async () => ({ Component: (await import('./builds/PrintSheet.tsx')).PrintSheet }) },
      // Protected routes: everything under RequireAuth needs a valid server-side session.
      {
        element: <RequireAuth />,
        children: [
          { path: 'dashboard', lazy: async () => ({ Component: (await import('./experiences/DashboardPage.tsx')).DashboardPage }) },
          { path: 'experiences/new', lazy: async () => ({ Component: (await import('./experiences/NewExperiencePage.tsx')).NewExperiencePage }) },
          { path: 'experiences/:id', lazy: async () => ({ Component: (await import('./experiences/ExperiencePage.tsx')).ExperiencePage }) },
          { path: 'library', lazy: async () => ({ Component: (await import('./assets/LibraryPage.tsx')).LibraryPage }) },
          { path: 'library/:assetId/ar-object', lazy: async () => ({ Component: (await import('./imageObjects/ImageObjectPage.tsx')).ImageObjectPage }) },
          { path: 'account', lazy: async () => ({ Component: (await import('./pages/AccountPage.tsx')).AccountPage }) },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

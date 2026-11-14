import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { authApi } from './api.ts';

export const SESSION_KEY = ['session'] as const;

/**
 * Authentication-aware state. The server is the source of truth: the session lives in an HttpOnly cookie that
 * JavaScript cannot read, so the UI asks /api/me. Refreshed on mount and after every auth action.
 */
export function useSession() {
  const q = useQuery({ queryKey: SESSION_KEY, queryFn: authApi.me, staleTime: 60_000, retry: false });
  return { user: q.data ?? null, isLoading: q.isPending, isError: q.isError, error: q.error, refetch: q.refetch };
}

export function useAuthConfig() {
  return useQuery({ queryKey: ['auth-config'], queryFn: authApi.config, staleTime: 5 * 60_000, retry: 1 });
}

export function useSignOut(everywhere = false) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: everywhere ? authApi.signOutEverywhere : authApi.signOut,
    onSettled: async () => {
      // Drop every cached server state belonging to the previous user.
      qc.clear();
      await qc.invalidateQueries({ queryKey: SESSION_KEY });
      navigate('/sign-in?signedOut=1', { replace: true });
    },
  });
}

/** Route guard: renders children only for signed-in users; otherwise redirects to sign-in with a return path. */
export function RequireAuth() {
  const { user, isLoading, isError } = useSession();
  const location = useLocation();
  if (isLoading) {
    return (
      <p role="status" aria-live="polite">
        Checking your session…
      </p>
    );
  }
  if (isError) {
    return <p role="alert">We could not check your session. Please reload the page.</p>;
  }
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/sign-in?next=${next}`} replace />;
  }
  return <Outlet />;
}

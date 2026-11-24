import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BuildSummary, PublicationStatus, TestBuildResponse } from '@ar-creator/contracts';
import { ApiRequestError, getJson, sendJson } from '../api/client.ts';

/** Test builds (Phase 5 M16, ADR-034). */
export const buildKeys = {
  latest: (experienceId: string) => ['builds', 'latest', experienceId] as const,
  test: (id: string, search: string) => ['builds', 'test', id, search] as const,
  publication: (experienceId: string) => ['builds', 'publication', experienceId] as const,
  public: (slug: string) => ['builds', 'public', slug] as const,
};

const active = (b: BuildSummary | null | undefined) => b?.state === 'queued' || b?.state === 'compiling';

/** The newest build of an experience, or null when there is none yet. Polls while compiling. */
export function useLatestBuild(experienceId: string) {
  return useQuery({
    queryKey: buildKeys.latest(experienceId),
    queryFn: async () => {
      try {
        return await getJson(`/api/experiences/${encodeURIComponent(experienceId)}/builds/latest`, BuildSummary);
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 404) return null;
        throw e;
      }
    },
    refetchInterval: (q) => (active(q.state.data) ? 1500 : false),
  });
}

export function useStartBuild(experienceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => sendJson('POST', `/api/experiences/${encodeURIComponent(experienceId)}/builds`, {}, BuildSummary),
    onSuccess: (b) => qc.setQueryData(buildKeys.latest(experienceId), b),
  });
}

/** Public: what the device test page shows. File links expire before the test link; refetch on focus and timer. */
export function useTestBuild(id: string, search: string) {
  return useQuery({
    queryKey: buildKeys.test(id, search),
    queryFn: () => getJson(`/api/test-builds/${encodeURIComponent(id)}${search}`, TestBuildResponse),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
  });
}

/** Published experience (public, stable URL). File links expire; refetch on focus and timer. */
export function usePublicExperience(slug: string) {
  return useQuery({
    queryKey: buildKeys.public(slug),
    queryFn: () => getJson(`/api/public/${encodeURIComponent(slug)}`, TestBuildResponse),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
  });
}

/** Publishing state of an experience; polls while a publish waits for its build. */
export function usePublication(experienceId: string) {
  return useQuery({
    queryKey: buildKeys.publication(experienceId),
    queryFn: () => getJson(`/api/experiences/${encodeURIComponent(experienceId)}/publication`, PublicationStatus),
    refetchInterval: (q) => (q.state.data?.state === 'publishing' ? 1500 : false),
  });
}

export function usePublish(experienceId: string, action: 'publish' | 'unpublish') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => sendJson('POST', `/api/experiences/${encodeURIComponent(experienceId)}/${action}`, {}, PublicationStatus),
    onSuccess: (p) => {
      qc.setQueryData(buildKeys.publication(experienceId), p);
      void qc.invalidateQueries({ queryKey: buildKeys.latest(experienceId) });
      void qc.invalidateQueries({ queryKey: ['experiences'] });
    },
  });
}

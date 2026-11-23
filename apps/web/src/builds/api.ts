import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BuildSummary, TestBuildResponse } from '@ar-creator/contracts';
import { ApiRequestError, getJson, sendJson } from '../api/client.ts';

/** Test builds (Phase 5 M16, ADR-034). */
export const buildKeys = {
  latest: (experienceId: string) => ['builds', 'latest', experienceId] as const,
  test: (id: string, search: string) => ['builds', 'test', id, search] as const,
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

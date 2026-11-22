import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AssetListResponse, ASSET_LIMITS, type UploadableRole } from '@ar-creator/contracts';
import { getJson, sendJson } from '../api/client.ts';

export const assetKeys = {
  all: ['assets'] as const,
  list: (role?: UploadableRole) => ['assets', 'list', role ?? 'all'] as const,
};

export const assetsApi = {
  list: (role?: UploadableRole) => getJson(role ? `/api/assets?role=${role}` : '/api/assets', AssetListResponse),
  remove: (id: string) => sendJson('DELETE', `/api/assets/${encodeURIComponent(id)}`, undefined, null),
};

/** Signed preview URLs expire (ADR-022); refetch well before that so <img> sources stay valid. */
const REFRESH_MS = (ASSET_LIMITS.readUrlTtlSeconds * 1000) / 2;

export function useAssets(role?: UploadableRole) {
  return useQuery({ queryKey: assetKeys.list(role), queryFn: () => assetsApi.list(role), staleTime: REFRESH_MS, refetchInterval: REFRESH_MS });
}

export function useDeleteAsset() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: assetsApi.remove, onSettled: () => qc.invalidateQueries({ queryKey: assetKeys.all }) });
}

export const invalidateAssets = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ queryKey: assetKeys.all });

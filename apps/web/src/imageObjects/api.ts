import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSET_LIMITS, AssetSummary, ConversionListResponse, ConversionSummary, ImageObjectListResponse, type ImageObjectSettingsInput } from '@ar-creator/contracts';
import { getJson, sendJson } from '../api/client.ts';
import { assetKeys } from '../assets/api.ts';

export const conversionKeys = {
  forAsset: (assetId: string) => ['conversions', 'asset', assetId] as const,
  one: (id: string) => ['conversions', 'one', id] as const,
  imageObjects: ['conversions', 'image-objects'] as const,
};

const api = {
  asset: (id: string) => getJson(`/api/assets/${encodeURIComponent(id)}`, AssetSummary),
  list: (assetId: string) => getJson(`/api/assets/${encodeURIComponent(assetId)}/image-objects`, ConversionListResponse),
  imageObjects: () => getJson('/api/image-objects', ImageObjectListResponse),
  get: (id: string) => getJson(`/api/conversions/${encodeURIComponent(id)}`, ConversionSummary),
  start: (assetId: string, settings: ImageObjectSettingsInput) =>
    sendJson('POST', `/api/assets/${encodeURIComponent(assetId)}/image-objects`, { settings }, ConversionSummary),
};

/** Signed URLs expire (ADR-022); refetch well before that so download links stay valid. */
const REFRESH_MS = (ASSET_LIMITS.readUrlTtlSeconds * 1000) / 2;
const active = (c: ConversionSummary | undefined) => c?.state === 'queued' || c?.state === 'running';

/** `null` = no asset to load (e.g. an image experience without a tracking image yet). */
export function useAsset(id: string | null) {
  return useQuery({ queryKey: [...assetKeys.all, 'one', id ?? 'none'], queryFn: () => api.asset(id!), enabled: id !== null, staleTime: REFRESH_MS, refetchInterval: REFRESH_MS });
}

export function useConversions(assetId: string) {
  return useQuery({
    queryKey: conversionKeys.forAsset(assetId),
    queryFn: () => api.list(assetId),
    staleTime: REFRESH_MS,
    // Poll while any conversion is still working; otherwise only to keep signed links fresh.
    refetchInterval: (q) => (q.state.data?.conversions.some(active) ? 1000 : REFRESH_MS),
  });
}

export function useConversion(id: string | null) {
  return useQuery({
    queryKey: conversionKeys.one(id ?? 'none'),
    queryFn: () => api.get(id!),
    enabled: id !== null,
    refetchInterval: (q) => (active(q.state.data) ? 1000 : REFRESH_MS),
    // A phone that slept past the signed-URL lifetime gets fresh "View in AR" links when the tab is shown again.
    refetchOnWindowFocus: true,
  });
}

export function useStartConversion(assetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: ImageObjectSettingsInput) => api.start(assetId, settings),
    onSuccess: (c) => {
      qc.setQueryData(conversionKeys.one(c.id), c);
      void qc.invalidateQueries({ queryKey: conversionKeys.forAsset(assetId) });
      void qc.invalidateQueries({ queryKey: assetKeys.all }); // storage usage changes
    },
  });
}

/** Finished image objects (GLB + USDZ pairs) that can be placed in experiences. */
export function useImageObjects() {
  // Always refetch on mount: a conversion finished on another page must show up here.
  return useQuery({ queryKey: conversionKeys.imageObjects, queryFn: api.imageObjects, staleTime: REFRESH_MS, refetchInterval: REFRESH_MS, refetchOnMount: 'always' });
}

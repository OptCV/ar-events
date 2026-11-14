import { useQuery } from '@tanstack/react-query';
import { HealthResponse } from '@ar-creator/contracts';
import { getJson } from './client.ts';

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => getJson('/api/health', HealthResponse),
    staleTime: 30_000,
    retry: 1,
  });
}

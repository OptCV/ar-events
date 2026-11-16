import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ExperienceDetail,
  ExperienceListResponse,
  ReadinessResponse,
  type CreateExperienceInput,
  type SaveDraftInput,
  type UpdateExperienceInput,
} from '@ar-creator/contracts';
import { getJson, sendJson } from '../api/client.ts';

export const experienceKeys = {
  all: ['experiences'] as const,
  detail: (id: string) => ['experiences', id] as const,
  readiness: (id: string) => ['experiences', id, 'readiness'] as const,
};

export const experiencesApi = {
  list: () => getJson('/api/experiences', ExperienceListResponse).then((r) => r.experiences),
  get: (id: string) => getJson(`/api/experiences/${encodeURIComponent(id)}`, ExperienceDetail),
  create: (input: CreateExperienceInput) => sendJson('POST', '/api/experiences', input, ExperienceDetail),
  update: (id: string, input: UpdateExperienceInput) => sendJson('PATCH', `/api/experiences/${encodeURIComponent(id)}`, input, ExperienceDetail),
  saveDraft: (id: string, input: SaveDraftInput) => sendJson('PUT', `/api/experiences/${encodeURIComponent(id)}/draft`, input, ExperienceDetail),
  validate: (id: string) => sendJson('POST', `/api/experiences/${encodeURIComponent(id)}/validate`, {}, ReadinessResponse),
  remove: (id: string) => sendJson('DELETE', `/api/experiences/${encodeURIComponent(id)}`, undefined, null),
};

export function useExperiences() {
  return useQuery({ queryKey: experienceKeys.all, queryFn: experiencesApi.list, staleTime: 10_000 });
}

export function useExperience(id: string) {
  return useQuery({ queryKey: experienceKeys.detail(id), queryFn: () => experiencesApi.get(id), staleTime: 10_000, retry: (n, e) => (e as { status?: number }).status !== 404 && n < 2 });
}

export function useReadiness(id: string, draftVersion: number | undefined) {
  return useQuery({
    queryKey: [...experienceKeys.readiness(id), draftVersion],
    queryFn: () => experiencesApi.validate(id),
    enabled: draftVersion !== undefined,
    staleTime: Infinity,
  });
}

export function useCreateExperience() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: experiencesApi.create,
    onSuccess: (e) => {
      qc.setQueryData(experienceKeys.detail(e.id), e);
      void qc.invalidateQueries({ queryKey: experienceKeys.all, exact: true });
    },
  });
}

export function useUpdateExperience(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateExperienceInput) => experiencesApi.update(id, input),
    onSuccess: (e) => {
      qc.setQueryData(experienceKeys.detail(id), e);
      void qc.invalidateQueries({ queryKey: experienceKeys.all, exact: true });
    },
  });
}

export function useDeleteExperience() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: experiencesApi.remove,
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: experienceKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: experienceKeys.all, exact: true });
    },
  });
}

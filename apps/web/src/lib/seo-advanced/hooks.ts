'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CreateSeoDomainInput,
  CreateTenantSeoProjectRequest,
  SeoProjectDto,
  SeoSummaryDto,
  SeoSyncRunDto,
  SeoWorkspaceDto,
  UpdateSeoDomainInput,
  UpdateSeoProjectInput,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

/** Mientras haya una descarga en marcha, se refresca cada 3 s. */
const POLL_MS = 3000;
const root = ['seo-advanced'] as const;

export const hasActiveRun = (project: SeoProjectDto | null | undefined): boolean =>
  !!project?.domains.some((d) => d.activeRun);

/** Su proyecto de SEO Avanzado (o nada si aún no lo creó). */
export function useSeoWorkspace() {
  return useQuery({
    queryKey: [...root, 'workspace'],
    queryFn: () => apiFetch<SeoWorkspaceDto>('/seo-advanced'),
    refetchInterval: (q) => (hasActiveRun(q.state.data?.project) ? POLL_MS : false),
  });
}

export function useSeoRuns(enabled: boolean, polling: boolean) {
  return useQuery({
    queryKey: [...root, 'runs'],
    queryFn: () => apiFetch<SeoSyncRunDto[]>('/seo-advanced/runs'),
    enabled,
    refetchInterval: polling ? POLL_MS : false,
  });
}

export function useSeoSummary(days: number, domainId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...root, 'summary', days, domainId],
    queryFn: () =>
      apiFetch<SeoSummaryDto>(
        `/seo-advanced/summary?days=${days}${domainId ? `&domainId=${domainId}` : ''}`,
      ),
    enabled,
  });
}

function useSeoMutation<TInput, TOutput>(fn: (input: TInput) => Promise<TOutput>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: root }),
  });
}

export const useCreateSeoProject = () =>
  useSeoMutation((input: CreateTenantSeoProjectRequest) =>
    apiFetch<SeoProjectDto>('/seo-advanced/project', { method: 'POST', json: input }),
  );

export const useUpdateSeoProject = () =>
  useSeoMutation((input: UpdateSeoProjectInput) =>
    apiFetch<SeoProjectDto>('/seo-advanced/project', { method: 'PATCH', json: input }),
  );

export const useAddSeoDomain = () =>
  useSeoMutation((input: CreateSeoDomainInput) =>
    apiFetch<SeoProjectDto>('/seo-advanced/domains', { method: 'POST', json: input }),
  );

export const useUpdateSeoDomain = () =>
  useSeoMutation(({ id, ...input }: UpdateSeoDomainInput & { id: string }) =>
    apiFetch<SeoProjectDto>(`/seo-advanced/domains/${id}`, { method: 'PATCH', json: input }),
  );

export const useRemoveSeoDomain = () =>
  useSeoMutation((id: string) =>
    apiFetch<SeoProjectDto>(`/seo-advanced/domains/${id}`, { method: 'DELETE' }),
  );

export const useCheckSeoDomain = () =>
  useSeoMutation((id: string) =>
    apiFetch<SeoProjectDto>(`/seo-advanced/domains/${id}/check`, { method: 'POST' }),
  );

export const useSyncSeoDomain = () =>
  useSeoMutation((id: string) =>
    apiFetch<SeoSyncRunDto>(`/seo-advanced/domains/${id}/sync`, { method: 'POST' }),
  );

export const useCancelSeoRun = () =>
  useSeoMutation((id: string) =>
    apiFetch<SeoSyncRunDto>(`/seo-advanced/runs/${id}/cancel`, { method: 'POST' }),
  );

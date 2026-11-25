'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  CreateSeoDomainInput,
  CreateSeoProjectInput,
  SeoGscPropertiesDto,
  SeoProjectDto,
  SeoSummaryDto,
  SeoSyncRunDto,
  SeoTenantProjectRowDto,
  UpdateSeoDomainInput,
  UpdateSeoProjectInput,
} from '@storageos/shared';

import { hasActiveRun } from '@/lib/seo-advanced/hooks';

const POLL_MS = 3000;
const root = ['admin', 'seo'] as const;

/** Proyectos de SEO de la plataforma. */
export function useAdminSeoProjects() {
  return useQuery({
    queryKey: [...root, 'projects'],
    queryFn: () => adminApiFetch<SeoProjectDto[]>('/admin/seo/projects'),
  });
}

/** Proyectos de los tenants (solo lectura). */
export function useAdminSeoTenantProjects(enabled: boolean) {
  return useQuery({
    queryKey: [...root, 'tenant-projects'],
    queryFn: () => adminApiFetch<SeoTenantProjectRowDto[]>('/admin/seo/tenant-projects'),
    enabled,
  });
}

/** Propiedades a las que tiene acceso la cuenta de servicio de Google. */
export function useAdminSeoProperties(enabled: boolean) {
  return useQuery({
    queryKey: [...root, 'properties'],
    queryFn: () => adminApiFetch<SeoGscPropertiesDto>('/admin/seo/properties'),
    enabled,
    staleTime: 60_000,
  });
}

export function useAdminSeoProject(id: string) {
  return useQuery({
    queryKey: [...root, 'project', id],
    queryFn: () => adminApiFetch<SeoProjectDto>(`/admin/seo/projects/${id}`),
    refetchInterval: (q) => (hasActiveRun(q.state.data) ? POLL_MS : false),
  });
}

export function useAdminSeoRuns(id: string, polling: boolean) {
  return useQuery({
    queryKey: [...root, 'runs', id],
    queryFn: () => adminApiFetch<SeoSyncRunDto[]>(`/admin/seo/projects/${id}/runs`),
    refetchInterval: polling ? POLL_MS : false,
  });
}

export function useAdminSeoSummary(id: string, days: number, domainId: string | null) {
  return useQuery({
    queryKey: [...root, 'summary', id, days, domainId],
    queryFn: () =>
      adminApiFetch<SeoSummaryDto>(
        `/admin/seo/projects/${id}/summary?days=${days}${domainId ? `&domainId=${domainId}` : ''}`,
      ),
  });
}

function useAdminSeoMutation<TInput, TOutput>(fn: (input: TInput) => Promise<TOutput>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: root }),
  });
}

export const useCreateAdminSeoProject = () =>
  useAdminSeoMutation((input: CreateSeoProjectInput) =>
    adminApiFetch<SeoProjectDto>('/admin/seo/projects', { method: 'POST', json: input }),
  );

export const useUpdateAdminSeoProject = (id: string) =>
  useAdminSeoMutation((input: UpdateSeoProjectInput) =>
    adminApiFetch<SeoProjectDto>(`/admin/seo/projects/${id}`, { method: 'PATCH', json: input }),
  );

export const useDeleteAdminSeoProject = () =>
  useAdminSeoMutation((id: string) =>
    adminApiFetch<void>(`/admin/seo/projects/${id}`, { method: 'DELETE' }),
  );

export const useAddAdminSeoDomain = (id: string) =>
  useAdminSeoMutation((input: CreateSeoDomainInput) =>
    adminApiFetch<SeoProjectDto>(`/admin/seo/projects/${id}/domains`, {
      method: 'POST',
      json: input,
    }),
  );

export const useUpdateAdminSeoDomain = (id: string) =>
  useAdminSeoMutation(({ id: domainId, ...input }: UpdateSeoDomainInput & { id: string }) =>
    adminApiFetch<SeoProjectDto>(`/admin/seo/projects/${id}/domains/${domainId}`, {
      method: 'PATCH',
      json: input,
    }),
  );

export const useRemoveAdminSeoDomain = (id: string) =>
  useAdminSeoMutation((domainId: string) =>
    adminApiFetch<SeoProjectDto>(`/admin/seo/projects/${id}/domains/${domainId}`, {
      method: 'DELETE',
    }),
  );

export const useCheckAdminSeoDomain = (id: string) =>
  useAdminSeoMutation((domainId: string) =>
    adminApiFetch<SeoProjectDto>(`/admin/seo/projects/${id}/domains/${domainId}/check`, {
      method: 'POST',
    }),
  );

export const useSyncAdminSeoDomain = (id: string) =>
  useAdminSeoMutation((domainId: string) =>
    adminApiFetch<SeoSyncRunDto>(`/admin/seo/projects/${id}/domains/${domainId}/sync`, {
      method: 'POST',
    }),
  );

export const useCancelAdminSeoRun = () =>
  useAdminSeoMutation((runId: string) =>
    adminApiFetch<SeoSyncRunDto>(`/admin/seo/runs/${runId}/cancel`, { method: 'POST' }),
  );

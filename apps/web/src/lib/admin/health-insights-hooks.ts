import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  AdminAdoptionInsightsDto,
  AdminBulkFollowupsInput,
  AdminBulkFollowupsResultDto,
  AdminPlatformHealthSettingsDto,
  AdminSavedViewDto,
  AdminTenantHealthHistoryDto,
  AdminUpgradeCandidatesDto,
  AdminUsageEvolutionDto,
  UpdatePlatformHealthSettingsInput,
} from '@storageos/shared';

/** Ajustes de Salud y Uso: pesos, aviso de caída y consumo anómalo. */
export function useHealthSettings() {
  return useQuery({
    queryKey: ['admin', 'health-settings'] as const,
    queryFn: () => adminApiFetch<AdminPlatformHealthSettingsDto>('/admin/health-settings'),
  });
}

export function useUpdateHealthSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformHealthSettingsInput) =>
      adminApiFetch<AdminPlatformHealthSettingsDto>('/admin/health-settings', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'health-settings'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'usage'] });
    },
  });
}

/** Evolución de la salud de un tenant (12 meses y 90 días). */
export function useTenantHealthHistory(id: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'tenants', id, 'health', 'history'] as const,
    queryFn: () =>
      adminApiFetch<AdminTenantHealthHistoryDto>(`/admin/tenants/${id}/health/history`),
    enabled: Boolean(id),
  });
}

/** Candidatos a subir de plan o contratar un extra. */
export function useUpgradeCandidates() {
  return useQuery({
    queryKey: ['admin', 'adoption', 'candidates'] as const,
    queryFn: () => adminApiFetch<AdminUpgradeCandidatesDto>('/admin/adoption/candidates'),
    staleTime: 60_000,
  });
}

/** Matriz función × plan, bajas por función y funciones que casi nadie usa. */
export function useAdoptionInsights() {
  return useQuery({
    queryKey: ['admin', 'adoption', 'insights'] as const,
    queryFn: () => adminApiFetch<AdminAdoptionInsightsDto>('/admin/adoption/insights'),
    staleTime: 300_000,
  });
}

/** Evolución mensual del uso (de todos, o de un tenant). */
export function useUsageEvolution(tenantId: string | null, months = 12, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'usage', 'evolution', tenantId ?? 'all', months] as const,
    queryFn: () =>
      adminApiFetch<AdminUsageEvolutionDto>(
        `/admin/usage/evolution?months=${months}${tenantId ? `&tenantId=${tenantId}` : ''}`,
      ),
    enabled,
  });
}

/** El mismo seguimiento en varios tenants. */
export function useBulkFollowups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminBulkFollowupsInput) =>
      adminApiFetch<AdminBulkFollowupsResultDto>('/admin/tenants/bulk-followups', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'followups'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
    },
  });
}

export type ListViewPage = 'health' | 'adoption' | 'usage' | 'leads';

/** Vistas guardadas de una de las listas de Salud, Adopción, Uso o Leads (por super admin). */
export function useListViews(page: ListViewPage) {
  return useQuery({
    queryKey: ['admin', 'saved-views', page] as const,
    queryFn: () => adminApiFetch<AdminSavedViewDto[]>(`/admin/saved-views?page=${page}`),
  });
}

export function useSaveListView(page: ListViewPage) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; filters: Record<string, unknown> }) =>
      adminApiFetch<AdminSavedViewDto>('/admin/saved-views', {
        method: 'POST',
        json: { page, ...input },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'saved-views', page] }),
  });
}

export function useDeleteListView(page: ListViewPage) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/saved-views/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'saved-views', page] }),
  });
}

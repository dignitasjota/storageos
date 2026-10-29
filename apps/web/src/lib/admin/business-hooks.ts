import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch, adminApiFetchBlob } from './api';

import type {
  AdminBusinessAlertsDto,
  AdminBusinessGoalsDto,
  AdminCollectionsForecastDto,
  AdminTenantBusinessDto,
  AdminTrialFunnelDto,
  UpdateBusinessAlertSettingsInput,
  UpdateBusinessGoalsInput,
} from '@storageos/shared';

/** Apartado «Negocio» del panel super admin. */

export function useTrialFunnel(months = 12) {
  return useQuery({
    queryKey: ['admin', 'business', 'trial-funnel', months] as const,
    queryFn: () =>
      adminApiFetch<AdminTrialFunnelDto>(`/admin/business/trial-funnel?months=${months}`),
    staleTime: 60_000,
  });
}

export function useBusinessGoals() {
  return useQuery({
    queryKey: ['admin', 'business', 'goals'] as const,
    queryFn: () => adminApiFetch<AdminBusinessGoalsDto>('/admin/business/goals'),
    staleTime: 60_000,
  });
}

export function useUpdateBusinessGoals() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateBusinessGoalsInput) =>
      adminApiFetch<AdminBusinessGoalsDto>('/admin/business/goals', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'business', 'goals'], data);
      void qc.invalidateQueries({ queryKey: ['admin', 'today'] });
    },
  });
}

export function useBusinessAlerts() {
  return useQuery({
    queryKey: ['admin', 'business', 'alerts'] as const,
    queryFn: () => adminApiFetch<AdminBusinessAlertsDto>('/admin/business/alerts'),
    staleTime: 60_000,
  });
}

export function useUpdateBusinessAlertSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateBusinessAlertSettingsInput) =>
      adminApiFetch<AdminBusinessAlertsDto>('/admin/business/alerts/settings', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: (data) => qc.setQueryData(['admin', 'business', 'alerts'], data),
  });
}

export function useTenantBusiness(tenantId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'business', 'tenant', tenantId] as const,
    queryFn: () => adminApiFetch<AdminTenantBusinessDto>(`/admin/business/tenants/${tenantId}`),
    enabled: enabled && !!tenantId,
    staleTime: 30_000,
  });
}

export function useCollectionsForecast() {
  return useQuery({
    queryKey: ['admin', 'finance', 'forecast'] as const,
    queryFn: () => adminApiFetch<AdminCollectionsForecastDto>('/admin/finance/forecast'),
    staleTime: 60_000,
  });
}

/** Descarga el informe mensual (CSV o PDF) del mes `YYYY-MM`. */
export async function downloadMonthlyReport(month: string, format: 'csv' | 'pdf'): Promise<void> {
  const blob = await adminApiFetchBlob(
    `/admin/business/monthly-report?month=${month}&format=${format}`,
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `informe-${month}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

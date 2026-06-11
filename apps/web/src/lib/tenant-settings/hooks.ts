import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  TenantBillingSettingsResponse,
  TenantSecuritySettingsResponse,
  UpdateTenantBillingSettingsInput,
  UpdateTenantSecuritySettingsInput,
} from '@storageos/shared';

export const tenantSecurityKey = ['settings', 'tenant', 'security'] as const;

export function useTenantSecuritySettings(enabled = true) {
  return useQuery({
    queryKey: tenantSecurityKey,
    queryFn: () => apiFetch<TenantSecuritySettingsResponse>('/settings/tenant/security'),
    enabled,
    staleTime: 0,
  });
}

export function useUpdateTenantSecuritySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantSecuritySettingsInput) =>
      apiFetch<TenantSecuritySettingsResponse>('/settings/tenant/security', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(tenantSecurityKey, data);
    },
  });
}

export const tenantBillingKey = ['settings', 'tenant', 'billing'] as const;

export function useTenantBillingSettings(enabled = true) {
  return useQuery({
    queryKey: tenantBillingKey,
    queryFn: () => apiFetch<TenantBillingSettingsResponse>('/settings/tenant/billing'),
    enabled,
    staleTime: 0,
  });
}

export function useUpdateTenantBillingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantBillingSettingsInput) =>
      apiFetch<TenantBillingSettingsResponse>('/settings/tenant/billing', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(tenantBillingKey, data);
    },
  });
}

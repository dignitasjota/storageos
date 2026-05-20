import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  TenantSecuritySettingsResponse,
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

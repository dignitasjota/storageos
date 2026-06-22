import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  TenantAccessSettingsResponse,
  UpdateTenantAccessSettingsInput,
} from '@storageos/shared';

const accessSettingsKey = ['settings', 'access'] as const;

export function useAccessSettings() {
  return useQuery({
    queryKey: accessSettingsKey,
    queryFn: () => apiFetch<TenantAccessSettingsResponse>('/settings/tenant/access'),
  });
}

export function useUpdateAccessSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantAccessSettingsInput) =>
      apiFetch<TenantAccessSettingsResponse>('/settings/tenant/access', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: accessSettingsKey }),
  });
}

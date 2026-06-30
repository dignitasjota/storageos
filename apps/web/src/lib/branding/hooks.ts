'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { TenantBrandingResponse, UpdateTenantBrandingInput } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const brandingKey = ['settings', 'tenant', 'branding'] as const;

export function useTenantBranding() {
  return useQuery({
    queryKey: brandingKey,
    queryFn: () => apiFetch<TenantBrandingResponse>('/settings/tenant/branding'),
  });
}

export function useUpdateTenantBranding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantBrandingInput) =>
      apiFetch<TenantBrandingResponse>('/settings/tenant/branding', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: brandingKey }),
  });
}

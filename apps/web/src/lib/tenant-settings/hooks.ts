import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  TenantBillingSettingsResponse,
  TenantMonthlyDigestResultDto,
  TenantMonthlyDigestSettingsResponse,
  TenantProfileResponse,
  TenantSecuritySettingsResponse,
  UpdateTenantBillingSettingsInput,
  UpdateTenantProfileInput,
  UpdateTenantSecuritySettingsInput,
} from '@storageos/shared';

const monthlyDigestKey = ['settings', 'tenant', 'monthly-digest'] as const;

export function useMonthlyDigestSettings(enabled = true) {
  return useQuery({
    queryKey: monthlyDigestKey,
    queryFn: () => apiFetch<TenantMonthlyDigestSettingsResponse>('/settings/tenant/monthly-digest'),
    enabled,
  });
}

export function useUpdateMonthlyDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<TenantMonthlyDigestSettingsResponse>('/settings/tenant/monthly-digest', {
        method: 'PATCH',
        json: { enabled },
      }),
    onSuccess: (data) => qc.setQueryData(monthlyDigestKey, data),
  });
}

export function useRunMonthlyDigest() {
  return useMutation({
    mutationFn: () =>
      apiFetch<TenantMonthlyDigestResultDto>('/settings/tenant/monthly-digest/run', {
        method: 'POST',
      }),
  });
}

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

export const tenantProfileKey = ['settings', 'tenant', 'profile'] as const;

export function useTenantProfile(enabled = true) {
  return useQuery({
    queryKey: tenantProfileKey,
    queryFn: () => apiFetch<TenantProfileResponse>('/settings/tenant/profile'),
    enabled,
  });
}

export function useUpdateTenantProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantProfileInput) =>
      apiFetch<TenantProfileResponse>('/settings/tenant/profile', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(tenantProfileKey, data);
      // El nombre sale en el menú y la zona horaria decide «Hoy».
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

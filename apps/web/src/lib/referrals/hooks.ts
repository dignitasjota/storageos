import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CustomerReferralCodeDto,
  ReferralDto,
  ReferralStatsDto,
  TenantReferralSettingsResponse,
  UpdateTenantReferralSettingsInput,
} from '@storageos/shared';

const referralsKey = ['referrals'] as const;
const referralStatsKey = ['referrals', 'stats'] as const;
const referralSettingsKey = ['settings', 'referrals'] as const;

export function useReferrals() {
  return useQuery({
    queryKey: referralsKey,
    queryFn: () => apiFetch<ReferralDto[]>('/referrals'),
  });
}

/** Código de referido de un inquilino (lo crea si aún no tiene). */
export function useCustomerReferralCode(customerId: string, enabled = true) {
  return useQuery({
    queryKey: [...referralsKey, 'code', customerId] as const,
    queryFn: () => apiFetch<CustomerReferralCodeDto>(`/referrals/customers/${customerId}/code`),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useReferralStats() {
  return useQuery({
    queryKey: referralStatsKey,
    queryFn: () => apiFetch<ReferralStatsDto>('/referrals/stats'),
  });
}

export function useReferralSettings() {
  return useQuery({
    queryKey: referralSettingsKey,
    queryFn: () => apiFetch<TenantReferralSettingsResponse>('/settings/tenant/referrals'),
  });
}

export function useUpdateReferralSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantReferralSettingsInput) =>
      apiFetch<TenantReferralSettingsResponse>('/settings/tenant/referrals', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: referralSettingsKey }),
  });
}

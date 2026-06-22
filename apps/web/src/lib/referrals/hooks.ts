import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
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

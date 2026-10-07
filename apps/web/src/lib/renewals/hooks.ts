import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AnniversarySettingsDto,
  AnniversaryUpdateDto,
  ApplyAnniversaryUpdatesResultDto,
  ContractDto,
} from '@storageos/shared';

/** Contratos que vencen pronto (renovación). */
export function useRenewals() {
  return useQuery({
    queryKey: ['contracts', 'renewals'] as const,
    queryFn: () => apiFetch<ContractDto[]>('/contracts/renewals'),
  });
}

const anniversaryKey = ['contract-anniversaries'] as const;

export function useAnniversarySettings() {
  return useQuery({
    queryKey: [...anniversaryKey, 'settings'],
    queryFn: () => apiFetch<AnniversarySettingsDto>('/contract-anniversaries/settings'),
  });
}

export function useUpdateAnniversarySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AnniversarySettingsDto) =>
      apiFetch<AnniversarySettingsDto>('/contract-anniversaries/settings', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: anniversaryKey }),
  });
}

export function useAnniversaryDue(enabled: boolean) {
  return useQuery({
    queryKey: [...anniversaryKey, 'due'],
    queryFn: () => apiFetch<AnniversaryUpdateDto[]>('/contract-anniversaries/due'),
    enabled,
  });
}

export function useApplyAnniversaryUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractIds: string[]; action: 'apply' | 'skip' }) =>
      apiFetch<ApplyAnniversaryUpdatesResultDto>('/contract-anniversaries/apply', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: anniversaryKey });
      void qc.invalidateQueries({ queryKey: ['contracts'] });
    },
  });
}

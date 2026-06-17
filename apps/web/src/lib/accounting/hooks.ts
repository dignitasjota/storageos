import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  HoldedSettingsDto,
  HoldedTestResultDto,
  UpdateHoldedSettingsInput,
} from '@storageos/shared';

const holdedKey = ['holded-settings'] as const;

export function useHoldedSettings() {
  return useQuery({
    queryKey: holdedKey,
    queryFn: () => apiFetch<HoldedSettingsDto>('/settings/holded'),
  });
}

export function useUpdateHoldedSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateHoldedSettingsInput) =>
      apiFetch<HoldedSettingsDto>('/settings/holded', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: holdedKey }),
  });
}

export function useTestHolded() {
  return useMutation({
    mutationFn: () => apiFetch<HoldedTestResultDto>('/settings/holded/test', { method: 'POST' }),
  });
}

export function useBackfillHolded() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ synced: number }>('/settings/holded/backfill', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: holdedKey }),
  });
}

export function useSyncInvoiceHolded() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invoiceId: string) =>
      apiFetch<{ ok: true }>(`/settings/holded/invoices/${invoiceId}/sync`, { method: 'POST' }),
    onSuccess: (_d, invoiceId) => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    },
  });
}

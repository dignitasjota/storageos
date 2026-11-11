import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CashClosureDto,
  CashDaySummaryDto,
  CloseCashInput,
  ReopenCashClosureInput,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

export function useCashSummary(date: string, facilityId?: string, enabled = true) {
  return useQuery({
    queryKey: ['cash', 'summary', date, facilityId ?? 'all'],
    queryFn: () =>
      apiFetch<CashDaySummaryDto>(
        `/cash/summary?date=${date}${facilityId ? `&facilityId=${facilityId}` : ''}`,
      ),
    enabled,
  });
}

export function useCashClosures() {
  return useQuery({
    queryKey: ['cash', 'closures'],
    queryFn: () => apiFetch<CashClosureDto[]>('/cash/closures'),
  });
}

export function useCloseCash() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CloseCashInput) =>
      apiFetch<CashClosureDto>('/cash/close', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cash'] });
    },
  });
}

/** Reabre un cierre (con motivo) para registrar un movimiento de ese día. */
export function useReopenCashClosure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: ReopenCashClosureInput }) =>
      apiFetch<CashClosureDto>(`/cash/closures/${args.id}/reopen`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cash'] });
    },
  });
}

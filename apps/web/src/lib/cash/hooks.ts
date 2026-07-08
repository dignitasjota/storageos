import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { CashClosureDto, CashDaySummaryDto, CloseCashInput } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

export function useCashSummary(date: string) {
  return useQuery({
    queryKey: ['cash', 'summary', date],
    queryFn: () => apiFetch<CashDaySummaryDto>(`/cash/summary?date=${date}`),
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

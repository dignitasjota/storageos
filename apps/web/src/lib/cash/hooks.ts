import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { CashClosureDto, CashDaySummaryDto, CloseCashInput } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

export function useCashSummary(date: string, facilityId?: string) {
  return useQuery({
    queryKey: ['cash', 'summary', date, facilityId ?? 'all'],
    queryFn: () =>
      apiFetch<CashDaySummaryDto>(
        `/cash/summary?date=${date}${facilityId ? `&facilityId=${facilityId}` : ''}`,
      ),
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

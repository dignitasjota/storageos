import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CashClosureDto,
  CashDaySummaryDto,
  CashMovementDto,
  CloseCashInput,
  CreateCashMovementInput,
  ReopenCashClosureInput,
} from '@storageos/shared';

import { apiFetch, apiFetchBlob } from '@/lib/auth/api';

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

/**
 * Cierres: los 90 últimos o los de un mes, de todas las cajas o de una
 * (`global` = la de toda la empresa).
 */
export function useCashClosures(filters: { month?: string; facilityId?: string } = {}) {
  const q = new URLSearchParams();
  if (filters.month) q.set('month', filters.month);
  if (filters.facilityId) q.set('facilityId', filters.facilityId);
  const qs = q.toString();
  return useQuery({
    queryKey: ['cash', 'closures', filters.month ?? null, filters.facilityId ?? null],
    queryFn: () => apiFetch<CashClosureDto[]>(`/cash/closures${qs ? `?${qs}` : ''}`),
  });
}

/** Fondo de apertura, entrada de cambio o retirada al banco. */
export function useAddCashMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCashMovementInput) =>
      apiFetch<CashMovementDto>('/cash/movements', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cash'] }),
  });
}

export function useDeleteCashMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/cash/movements/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cash'] }),
  });
}

/** Descarga el cierre en PDF (para imprimirlo y firmarlo). */
export async function downloadClosurePdf(closure: CashClosureDto): Promise<void> {
  const blob = await apiFetchBlob(`/cash/closures/${closure.id}/pdf`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cierre-de-caja-${closure.date}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
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

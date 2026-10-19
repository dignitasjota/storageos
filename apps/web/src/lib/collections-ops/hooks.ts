import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  ArrearsDto,
  CreatePaymentPlanInput,
  MonthCollectionsDto,
  PaymentPlanDto,
} from '@storageos/shared';

function qs(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Cobros del mes: previsto por vía de cobro, cobrado, fallido y devuelto. */
export function useMonthCollections(month: string, facilityId?: string) {
  return useQuery({
    queryKey: ['collections-month', month, facilityId ?? null] as const,
    queryFn: () => apiFetch<MonthCollectionsDto>(`/collections-month${qs({ month, facilityId })}`),
  });
}

/** Deudores: un inquilino por fila con su deuda vencida y el paso del escalado. */
export function useArrears(facilityId?: string) {
  return useQuery({
    queryKey: ['arrears', facilityId ?? null] as const,
    queryFn: () => apiFetch<ArrearsDto>(`/arrears${qs({ facilityId })}`),
  });
}

export function usePaymentPlans(params: { customerId?: string; status?: string } = {}) {
  return useQuery({
    queryKey: ['payment-plans', params] as const,
    queryFn: () => apiFetch<PaymentPlanDto[]>(`/payment-plans${qs(params)}`),
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['payment-plans'] });
  void qc.invalidateQueries({ queryKey: ['arrears'] });
  void qc.invalidateQueries({ queryKey: ['customers'] });
}

export function useCreatePaymentPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: Partial<CreatePaymentPlanInput> & Pick<CreatePaymentPlanInput, 'customerId'>,
    ) => apiFetch<PaymentPlanDto>('/payment-plans', { method: 'POST', json: input }),
    onSuccess: () => invalidate(qc),
  });
}

export function useCancelPaymentPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PaymentPlanDto>(`/payment-plans/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => invalidate(qc),
  });
}

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AccessCutPendingDto,
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
    // Al cambiar de mes se ve el anterior mientras carga (no la página en blanco).
    placeholderData: keepPreviousData,
  });
}

/** Deudores: un inquilino por fila con su deuda vencida y el paso del escalado. */
export function useArrears(facilityId?: string) {
  return useQuery({
    queryKey: ['arrears', facilityId ?? null] as const,
    queryFn: () => apiFetch<ArrearsDto>(`/arrears${qs({ facilityId })}`),
  });
}

export function usePaymentPlans(
  params: { customerId?: string; status?: string; facilityId?: string } = {},
) {
  return useQuery({
    queryKey: ['payment-plans', params] as const,
    queryFn: () => apiFetch<PaymentPlanDto[]>(`/payment-plans${qs(params)}`),
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    'payment-plans',
    'arrears',
    'customers',
    'collections-month',
    'invoices',
    'dashboard',
  ]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
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

/** Inquilinos con deuda a los que el corte de acceso no llegó a aplicarse. */
export function useAccessCutPending(facilityId?: string, enabled = true) {
  return useQuery({
    queryKey: ['access-cuts', facilityId ?? null] as const,
    queryFn: () => apiFetch<AccessCutPendingDto>(`/access/debt-cuts${qs({ facilityId })}`),
    enabled,
  });
}

function invalidateCuts(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['access-cuts'] });
  void qc.invalidateQueries({ queryKey: ['arrears'] });
  void qc.invalidateQueries({ queryKey: ['access'] });
}

export function useCutAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (customerId: string) =>
      apiFetch<{ suspended: number }>(`/access/debt-cuts/${customerId}/cut`, { method: 'POST' }),
    onSuccess: () => invalidateCuts(qc),
  });
}

export function useSkipAccessCut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (customerId: string) =>
      apiFetch<void>(`/access/debt-cuts/${customerId}/skip`, { method: 'POST' }),
    onSuccess: () => invalidateCuts(qc),
  });
}

export function useCutAllAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (facilityId?: string) =>
      apiFetch<{ customers: number; suspended: number; failed: number }>(
        `/access/debt-cuts/cut-all${qs({ facilityId })}`,
        { method: 'POST' },
      ),
    onSuccess: () => invalidateCuts(qc),
  });
}

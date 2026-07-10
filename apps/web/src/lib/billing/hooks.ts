import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  BulkInvoiceActionResultDto,
  CancelInvoiceInput,
  ChargeInvoiceInput,
  CreateInvoiceInput,
  CreateInvoiceSeriesInput,
  DataSubjectRequestDto,
  DunningActionDto,
  InvoiceDto,
  InvoiceSeriesDto,
  MarkPaidManuallyInput,
  PaymentDto,
  PaymentMethodDto,
  RectifyInvoiceInput,
  RefundInvoiceInput,
  RegisterPaymentMethodInput,
  SetupIntentResponseDto,
  UpdateInvoiceSeriesInput,
} from '@storageos/shared';

export const invoicesKey = (filters?: Record<string, string | undefined>) =>
  ['invoices', filters ?? {}] as const;
export const invoiceKey = (id: string) => ['invoices', id] as const;
export const seriesKey = ['invoice-series'] as const;
export const paymentsKey = (filters?: Record<string, string | undefined>) =>
  ['payments', filters ?? {}] as const;
export const paymentMethodsKey = (customerId: string) => ['payment-methods', customerId] as const;
export const dunningKey = ['dunning'] as const;
export const rgpdKey = ['rgpd', 'requests'] as const;

// ============================================================================
// Invoice series
// ============================================================================

export function useInvoiceSeries() {
  return useQuery({
    queryKey: seriesKey,
    queryFn: () => apiFetch<InvoiceSeriesDto[]>('/invoice-series'),
    staleTime: 60_000,
  });
}

export function useCreateInvoiceSeries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInvoiceSeriesInput) =>
      apiFetch<InvoiceSeriesDto>('/invoice-series', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: seriesKey });
    },
  });
}

export function useUpdateInvoiceSeries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateInvoiceSeriesInput }) =>
      apiFetch<InvoiceSeriesDto>(`/invoice-series/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: seriesKey });
    },
  });
}

// ============================================================================
// Invoices
// ============================================================================

interface InvoiceFilters {
  status?: string;
  customerId?: string;
  contractId?: string;
  overdue?: 'true';
}

export function useInvoices(filters: InvoiceFilters = {}) {
  return useQuery({
    queryKey: invoicesKey(filters as Record<string, string | undefined>),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      const qs = params.toString();
      return apiFetch<InvoiceDto[]>(`/invoices${qs ? `?${qs}` : ''}`);
    },
    staleTime: 15_000,
  });
}

export function useInvoice(id: string | undefined) {
  return useQuery({
    queryKey: id ? invoiceKey(id) : ['invoice', 'none'],
    queryFn: () => apiFetch<InvoiceDto>(`/invoices/${id}`),
    enabled: !!id,
  });
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInvoiceInput) =>
      apiFetch<InvoiceDto>('/invoices', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

function makeInvoiceAction<T>(action: string) {
  return function useInvoiceAction() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (args: { id: string; body?: T }) =>
        apiFetch<InvoiceDto>(`/invoices/${args.id}/${action}`, {
          method: 'POST',
          json: args.body,
        }),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ['invoices'] });
      },
    });
  };
}

export const useIssueInvoice = makeInvoiceAction<undefined>('issue');
export const useCancelInvoice = makeInvoiceAction<CancelInvoiceInput>('cancel');
export const useRefundInvoice = makeInvoiceAction<RefundInvoiceInput>('refund');
export const useMarkInvoicePaid = makeInvoiceAction<MarkPaidManuallyInput>('mark-paid');
/** Emite una factura de recargo por mora sobre una factura vencida. */
export const useLateFeeInvoice = makeInvoiceAction<undefined>('late-fee');

/**
 * Crea una factura rectificativa (R1-R5) sobre una factura original ya
 * emitida. La rectificativa queda en `draft`; el usuario tendra que
 * emitirla explicitamente.
 */
export function useRectifyInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: RectifyInvoiceInput }) =>
      apiFetch<InvoiceDto>(`/invoices/${args.id}/rectify`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

export function useGenerateInvoicePdf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ pdfUrl: string }>(`/invoices/${id}/generate-pdf`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: invoiceKey(id) });
    },
  });
}

// ============================================================================
// Payments
// ============================================================================

interface PaymentFilters {
  invoiceId?: string;
  customerId?: string;
}

export function usePayments(filters: PaymentFilters = {}) {
  return useQuery({
    queryKey: paymentsKey(filters as Record<string, string | undefined>),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      const qs = params.toString();
      return apiFetch<PaymentDto[]>(`/payments${qs ? `?${qs}` : ''}`);
    },
    staleTime: 30_000,
  });
}

export function useChargeInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { invoiceId: string; input: ChargeInvoiceInput }) =>
      apiFetch<PaymentDto>(`/payments/invoices/${args.invoiceId}/charge`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: (_d, args) => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: invoiceKey(args.invoiceId) });
    },
  });
}

/** Emisión en lote de N borradores. */
export function useBulkIssueInvoices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<BulkInvoiceActionResultDto>('/invoices/bulk/issue', {
        method: 'POST',
        json: { ids },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

/** Envío en lote de un recordatorio de pago a N facturas pendientes. */
export function useBulkRemindInvoices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<BulkInvoiceActionResultDto>('/invoices/bulk/remind', {
        method: 'POST',
        json: { ids },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['communications'] });
    },
  });
}

/** Cobro en lote de N facturas con el método por defecto de cada cliente. */
export function useBulkChargeInvoices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<BulkInvoiceActionResultDto>('/payments/invoices/bulk/charge', {
        method: 'POST',
        json: { ids },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
    },
  });
}

export function useCustomerPaymentMethods(customerId: string | undefined) {
  return useQuery({
    queryKey: customerId ? paymentMethodsKey(customerId) : ['pm', 'none'],
    queryFn: () => apiFetch<PaymentMethodDto[]>(`/customers/${customerId}/payment-methods`),
    enabled: !!customerId,
  });
}

export function useCreateSetupIntent() {
  return useMutation({
    mutationFn: (customerId: string) =>
      apiFetch<SetupIntentResponseDto>('/payment-methods/setup-intent', {
        method: 'POST',
        json: { customerId },
      }),
  });
}

export function useRegisterPaymentMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterPaymentMethodInput) =>
      apiFetch<PaymentMethodDto>('/payment-methods', { method: 'POST', json: input }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: paymentMethodsKey(data.customerId) });
    },
  });
}

export function useRemovePaymentMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; customerId: string }) =>
      apiFetch<void>(`/payment-methods/${args.id}`, { method: 'DELETE' }),
    onSuccess: (_d, args) => {
      void qc.invalidateQueries({ queryKey: paymentMethodsKey(args.customerId) });
    },
  });
}

// ============================================================================
// Dunning + RGPD
// ============================================================================

export function useDunningActions() {
  return useQuery({
    queryKey: dunningKey,
    queryFn: () => apiFetch<DunningActionDto[]>('/dunning'),
    staleTime: 30_000,
  });
}

export function useDataSubjectRequests() {
  return useQuery({
    queryKey: rgpdKey,
    queryFn: () => apiFetch<DataSubjectRequestDto[]>('/rgpd/requests'),
    staleTime: 60_000,
  });
}

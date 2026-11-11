import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  LateFeePreviewDto,
  ReturnedReceiptsDto,
  BulkInvoiceActionResultDto,
  CancelInvoiceInput,
  VoidInvoiceInput,
  ChargeInvoiceInput,
  CorrectPaymentInput,
  CreateInvoiceInput,
  CreateInvoiceSeriesInput,
  DataSubjectRequestDto,
  DunningActionDto,
  InvoiceActivityDto,
  InvoiceCancelPreviewDto,
  InvoiceDto,
  InvoiceRefundOptionsDto,
  InvoiceSavedViewDto,
  InvoiceSeriesDto,
  InvoiceTotalsDto,
  MarkPaidManuallyInput,
  MonthCloseDto,
  MonthCloseGenerateResultDto,
  PageDto,
  PaymentDto,
  PaymentMethodDto,
  RectifyInvoiceInput,
  RefundInvoiceInput,
  RegisterPaymentMethodInput,
  SaveInvoiceViewInput,
  SendInvoiceEmailInput,
  SendInvoiceEmailResultDto,
  SetupIntentResponseDto,
  SignedDownloadDto,
  UpdateInvoiceInput,
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
  /** Local de la cabecera (lista de facturas). */
  facilityId?: string;
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

/** Lo que cambia al emitir, cobrar, devolver o anular una factura. */
export function invalidateBilling(qc: ReturnType<typeof useQueryClient>): void {
  for (const key of [
    'invoices',
    'payments',
    'arrears',
    'collections-month',
    'dashboard',
    'customers',
    'contracts',
    'access-cuts',
    // Un cobro o una devolución en efectivo cambian el arqueo del día.
    'cash',
  ]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
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
      onSuccess: () => invalidateBilling(qc),
    });
  };
}

/** Cuánto sería el recargo por mora de una factura vencida. */
export function fetchLateFeePreview(id: string): Promise<LateFeePreviewDto> {
  return apiFetch<LateFeePreviewDto>(`/invoices/${id}/late-fee-preview`);
}

/** Cambia el vencimiento (con motivo, si ya está emitida) o las notas. */
export function useUpdateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateInvoiceInput }) =>
      apiFetch<InvoiceDto>(`/invoices/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => invalidateBilling(qc),
  });
}

/** Filtros de la lista de facturas, tal como los entiende el API. */
export type InvoiceListParams = Record<string, string | undefined>;

function query(params: InvoiceListParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/** Lo que suman las facturas de esos filtros. */
export function useInvoiceTotals(params: InvoiceListParams) {
  return useQuery({
    queryKey: ['invoices', 'totals', params] as const,
    queryFn: () => apiFetch<InvoiceTotalsDto>(`/invoices/totals${query(params)}`),
    placeholderData: (prev) => prev,
  });
}

/** Todas las facturas de esos filtros (para el CSV), hasta `max`. */
export async function fetchAllInvoices(
  params: InvoiceListParams,
  max = 5000,
): Promise<{ rows: InvoiceDto[]; truncated: boolean }> {
  const rows: InvoiceDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await apiFetch<PageDto<InvoiceDto>>(
      `/invoices/page${query({ ...params, limit: '100', cursor })}`,
    );
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && rows.length < max);
  return { rows: rows.slice(0, max), truncated: !!cursor || rows.length > max };
}

export function useInvoiceViews() {
  return useQuery({
    queryKey: ['invoices', 'views'] as const,
    queryFn: () => apiFetch<InvoiceSavedViewDto[]>('/invoices/views'),
    staleTime: 60_000,
  });
}

export function useSaveInvoiceView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveInvoiceViewInput) =>
      apiFetch<InvoiceSavedViewDto>('/invoices/views', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invoices', 'views'] }),
  });
}

export function useDeleteInvoiceView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/invoices/views/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invoices', 'views'] }),
  });
}

/** Cobros, devoluciones, avisos, pasos del escalado e historial de una factura. */
export function useInvoiceActivity(id: string | undefined) {
  return useQuery({
    queryKey: ['invoices', id ?? 'none', 'activity'] as const,
    queryFn: () => apiFetch<InvoiceActivityDto>(`/invoices/${id}/activity`),
    enabled: !!id,
  });
}

/** Qué pasará al anular una factura (antes de confirmarlo). */
export function fetchCancelPreview(id: string): Promise<InvoiceCancelPreviewDto> {
  return apiFetch<InvoiceCancelPreviewDto>(`/invoices/${id}/cancel-preview`);
}

/** Cómo se devolvería el dinero de una factura. */
export function fetchRefundOptions(id: string): Promise<InvoiceRefundOptionsDto> {
  return apiFetch<InvoiceRefundOptionsDto>(`/invoices/${id}/refund-options`);
}

export function useDuplicateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<InvoiceDto>(`/invoices/${id}/duplicate`, { method: 'POST' }),
    onSuccess: () => invalidateBilling(qc),
  });
}

export function useSendInvoiceEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: SendInvoiceEmailInput }) =>
      apiFetch<SendInvoiceEmailResultDto>(`/invoices/${args.id}/send`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: (_res, args) =>
      void qc.invalidateQueries({ queryKey: ['invoices', args.id, 'activity'] }),
  });
}

/** Deshacer un cobro registrado a mano por error. */
export function useUndoPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { invoiceId: string; paymentId: string; reason: string }) =>
      apiFetch<InvoiceDto>(`/invoices/${args.invoiceId}/payments/${args.paymentId}/undo`, {
        method: 'POST',
        json: { reason: args.reason },
      }),
    onSuccess: () => invalidateBilling(qc),
  });
}

/** Corregir la fecha o la forma de pago de un cobro registrado a mano. */
export function useCorrectPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { invoiceId: string; paymentId: string; input: CorrectPaymentInput }) =>
      apiFetch<InvoiceDto>(`/invoices/${args.invoiceId}/payments/${args.paymentId}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => invalidateBilling(qc),
  });
}

/** Cierre del mes: lo que falta por generar, emitir y cobrar. */
export function useMonthClose(month: string) {
  return useQuery({
    queryKey: ['invoices', 'month-close', month] as const,
    queryFn: () => apiFetch<MonthCloseDto>(`/invoices/month-close?month=${month}`),
    placeholderData: (prev) => prev,
  });
}

export function useGenerateMonth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (month: string) =>
      apiFetch<MonthCloseGenerateResultDto>('/invoices/month-close/generate', {
        method: 'POST',
        json: { month },
      }),
    onSuccess: () => invalidateBilling(qc),
  });
}

export const useIssueInvoice = makeInvoiceAction<undefined>('issue');
export const useCancelInvoice = makeInvoiceAction<CancelInvoiceInput>('cancel');
/** Anular una factura emitida por error (registro de anulación, fuera de los libros). */
export const useVoidInvoice = makeInvoiceAction<VoidInvoiceInput>('void');
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

/**
 * El PDF vive en un bucket privado sin URL pública — pide una URL firmada
 * de corta duración justo antes de abrirla.
 */
export function useInvoiceSignedPdfUrl() {
  return useMutation({
    mutationFn: (id: string) => apiFetch<SignedDownloadDto>(`/invoices/${id}/signed-pdf`),
  });
}

// ============================================================================
// Payments
// ============================================================================

interface PaymentFilters {
  invoiceId?: string;
  customerId?: string;
  facilityId?: string;
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
    onSuccess: () => invalidateBilling(qc),
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
    onSuccess: () => invalidateBilling(qc),
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
    onSuccess: () => invalidateBilling(qc),
  });
}

export function useCustomerPaymentMethods(customerId: string | undefined) {
  return useQuery({
    queryKey: customerId ? paymentMethodsKey(customerId) : ['pm', 'none'],
    queryFn: () => apiFetch<PaymentMethodDto[]>(`/customers/${customerId}/payment-methods`),
    enabled: !!customerId,
  });
}

/** ¿Se puede registrar tarjeta/IBAN por Stripe? (desactivado sin Stripe Connect). */
export function usePaymentOptions() {
  return useQuery({
    queryKey: ['payment-methods', 'options'],
    queryFn: () => apiFetch<{ cardPayments: boolean }>('/payment-methods/options'),
    staleTime: 5 * 60_000,
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

export interface ReturnedReceiptsFilters {
  from?: string;
  to?: string;
  kind?: string;
  facilityId?: string;
}

/** Recibos devueltos y adeudos rechazados del periodo. */
export function useReturnedReceipts(filters: ReturnedReceiptsFilters) {
  return useQuery({
    queryKey: ['payments', 'returns', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      const qs = params.toString();
      return apiFetch<ReturnedReceiptsDto>(`/payments/returns${qs ? `?${qs}` : ''}`);
    },
    staleTime: 30_000,
  });
}

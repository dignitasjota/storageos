import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  HoldedReviewItemDto,
  HoldedSeriesListDto,
  HoldedSettingsDto,
  HoldedTestResultDto,
  InvoiceDto,
  InvoicingModeDto,
  InvoicingModeValue,
  ResolveHoldedReviewInput,
  UpdateHoldedSettingsInput,
} from '@storageos/shared';

const holdedKey = ['holded-settings'] as const;

export function useHoldedSettings() {
  return useQuery({
    queryKey: holdedKey,
    queryFn: () => apiFetch<HoldedSettingsDto>('/settings/holded'),
  });
}

/** Series de la cuenta de Holded del tenant (solo si ya hay API key). */
export function useHoldedSeries(enabled: boolean) {
  return useQuery({
    queryKey: [...holdedKey, 'series'],
    queryFn: () => apiFetch<HoldedSeriesListDto>('/settings/holded/series'),
    enabled,
    retry: false,
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

/** Copias sin confirmar y cobros devueltos que hay que revisar en Holded. */
export function useHoldedReview(enabled: boolean) {
  return useQuery({
    queryKey: [...holdedKey, 'review'],
    queryFn: () => apiFetch<HoldedReviewItemDto[]>('/settings/holded/review'),
    enabled,
  });
}

export function useResolveHoldedReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { item: HoldedReviewItemDto; input: ResolveHoldedReviewInput }) =>
      apiFetch<{ ok: true }>(
        `/settings/holded/review/${args.item.kind === 'invoice_unconfirmed' ? 'invoices' : 'payments'}/${args.item.id}`,
        { method: 'POST', json: args.input },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: holdedKey }),
  });
}

/** Modo Holded: enlaza la rectificativa que el tenant creó en Holded. */
export function useLinkHoldedCreditNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { invoiceId: string; holdedDocumentId: string }) =>
      apiFetch<InvoiceDto>(`/invoices/${args.invoiceId}/link-holded`, {
        method: 'POST',
        json: { holdedDocumentId: args.holdedDocumentId },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: holdedKey });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

const invoicingModeKey = ['invoicing-mode'] as const;

/** Dónde se emiten las facturas del tenant (la app con Veri*Factu, u Holded). */
export function useInvoicingMode() {
  return useQuery({
    queryKey: invoicingModeKey,
    queryFn: () => apiFetch<InvoicingModeDto>('/settings/invoicing-mode'),
  });
}

export function useUpdateInvoicingMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: InvoicingModeValue) =>
      apiFetch<InvoicingModeDto>('/settings/invoicing-mode', { method: 'PUT', json: { mode } }),
    onSuccess: (data) => qc.setQueryData(invoicingModeKey, data),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  BulkCustomerMessageInput,
  BulkCustomerTagsInput,
  CreateCustomerDocumentRequestInput,
  CustomerContactDto,
  CustomerDocumentRequestDto,
  CustomerInsightsDto,
  CustomerMergePreviewDto,
  CustomerMessageInput,
  CustomerSavedViewDto,
  CustomerTimelineItemDto,
  DeletedCustomerDto,
  SaveCustomerViewInput,
  UpsertCustomerContactInput,
} from '@storageos/shared';

/** Clave con la que Campañas recoge la selección hecha en la lista de inquilinos. */
export const CAMPAIGN_SELECTION_KEY = 'storageos.campaign.customerIds';

export function useCustomerInsights(id: string) {
  return useQuery({
    queryKey: ['customers', id, 'insights'],
    queryFn: () => apiFetch<CustomerInsightsDto>(`/customers/${id}/insights`),
  });
}

export function useCustomerTimeline(id: string) {
  return useQuery({
    queryKey: ['customers', id, 'timeline'],
    queryFn: () => apiFetch<CustomerTimelineItemDto[]>(`/customers/${id}/timeline`),
  });
}

export function useCustomerContacts(id: string) {
  return useQuery({
    queryKey: ['customers', id, 'contacts'],
    queryFn: () => apiFetch<CustomerContactDto[]>(`/customers/${id}/contacts`),
  });
}

export function useSaveCustomerContact(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id?: string; input: UpsertCustomerContactInput }) =>
      apiFetch<CustomerContactDto>(
        `/customers/${customerId}/contacts${args.id ? `/${args.id}` : ''}`,
        { method: args.id ? 'PATCH' : 'POST', json: args.input },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers', customerId, 'contacts'] }),
  });
}

export function useDeleteCustomerContact(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/customers/${customerId}/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers', customerId, 'contacts'] }),
  });
}

export function useCustomerDocumentRequests(id: string) {
  return useQuery({
    queryKey: ['customers', id, 'document-requests'],
    queryFn: () => apiFetch<CustomerDocumentRequestDto[]>(`/customers/${id}/document-requests`),
  });
}

export function useRequestCustomerDocument(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomerDocumentRequestInput) =>
      apiFetch<CustomerDocumentRequestDto>(`/customers/${id}/document-requests`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['customers', id, 'document-requests'] }),
  });
}

export function useCancelDocumentRequest(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) =>
      apiFetch<void>(`/customers/${id}/document-requests/${requestId}`, { method: 'DELETE' }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['customers', id, 'document-requests'] }),
  });
}

export function useCustomerViews() {
  return useQuery({
    queryKey: ['customers', 'views'],
    queryFn: () => apiFetch<CustomerSavedViewDto[]>('/customers/views'),
  });
}

export function useSaveCustomerView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveCustomerViewInput) =>
      apiFetch<CustomerSavedViewDto>('/customers/views', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers', 'views'] }),
  });
}

export function useDeleteCustomerView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/customers/views/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers', 'views'] }),
  });
}

export function useDeletedCustomers() {
  return useQuery({
    queryKey: ['customers', 'deleted'],
    queryFn: () => apiFetch<DeletedCustomerDto[]>('/customers/deleted'),
  });
}

export function useRestoreCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/customers/${id}/restore`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers'] }),
  });
}

export function useMergePreview(targetId: string, sourceId: string | null) {
  return useQuery({
    queryKey: ['customers', targetId, 'merge-preview', sourceId],
    queryFn: () =>
      apiFetch<CustomerMergePreviewDto>(
        `/customers/${targetId}/merge-preview?sourceId=${sourceId}`,
      ),
    enabled: !!sourceId,
  });
}

export function useMergeCustomer(targetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      apiFetch<void>(`/customers/${targetId}/merge`, { method: 'POST', json: { sourceId } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers'] }),
  });
}

export function useSendCustomerMessage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomerMessageInput) =>
      apiFetch<{ recipient: string }>(`/customers/${id}/message`, { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['communications'] });
      void qc.invalidateQueries({ queryKey: ['customers', id, 'timeline'] });
    },
  });
}

export function useBulkCustomerTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkCustomerTagsInput) =>
      apiFetch<{ updated: number }>('/customers/bulk/tags', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers'] }),
  });
}

export function useBulkCustomerMessage() {
  return useMutation({
    mutationFn: (input: BulkCustomerMessageInput) =>
      apiFetch<{ sent: number; skipped: number }>('/customers/bulk/message', {
        method: 'POST',
        json: input,
      }),
  });
}

export function useRemindCustomers() {
  return useMutation({
    mutationFn: (customerIds: string[]) =>
      apiFetch<{ succeeded: string[]; failed: { id: string; error: string }[] }>(
        '/invoices/bulk/remind-customers',
        { method: 'POST', json: { customerIds } },
      ),
  });
}

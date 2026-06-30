import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateCustomerFollowupInput,
  CustomerFollowupDto,
  FollowupStatusValue,
} from '@storageos/shared';

/** Bandeja global de seguimientos pendientes (sondea cada 60 s). */
export function useFollowupsPending() {
  return useQuery({
    queryKey: ['followups', 'pending'] as const,
    queryFn: () => apiFetch<CustomerFollowupDto[]>('/followups'),
    refetchInterval: 60_000,
  });
}

export function useCustomerFollowups(customerId: string | undefined) {
  return useQuery({
    queryKey: ['followups', 'customer', customerId] as const,
    queryFn: () => apiFetch<CustomerFollowupDto[]>(`/customers/${customerId}/followups`),
    enabled: Boolean(customerId),
  });
}

export function useCreateFollowup(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomerFollowupInput) =>
      apiFetch<CustomerFollowupDto>(`/customers/${customerId}/followups`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['followups'] }),
  });
}

export function useUpdateFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; status: FollowupStatusValue }) =>
      apiFetch<CustomerFollowupDto>(`/followups/${args.id}`, {
        method: 'PATCH',
        json: { status: args.status },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['followups'] }),
  });
}

export function useDeleteFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/followups/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['followups'] }),
  });
}

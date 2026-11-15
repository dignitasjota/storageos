import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateCustomerFollowupInput,
  CustomerFollowupDto,
  FollowupDueCountDto,
  FollowupInboxDto,
  FollowupInboxTab,
  UpdateCustomerFollowupInput,
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
    mutationFn: ({ id, ...input }: { id: string } & UpdateCustomerFollowupInput) =>
      apiFetch<CustomerFollowupDto>(`/followups/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['followups'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** Bandeja única (inquilinos y contactos) por pestaña. */
export function useFollowupInbox(tab: FollowupInboxTab, mine: boolean) {
  return useQuery({
    queryKey: ['followups', 'inbox', tab, mine] as const,
    queryFn: () =>
      apiFetch<FollowupInboxDto>(`/followups/inbox?tab=${tab}${mine ? '&mine=1' : ''}`),
    refetchInterval: 60_000,
  });
}

/** Los de hoy y atrasados (número del menú). */
export function useFollowupDueCount(enabled = true) {
  return useQuery({
    queryKey: ['followups', 'due-count'] as const,
    queryFn: () => apiFetch<FollowupDueCountDto>('/followups/due-count'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}

export function useDeleteFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/followups/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['followups'] }),
  });
}

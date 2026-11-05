import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { liveRefetchInterval } from '../realtime/store';

import type {
  BroadcastMessageInput,
  ConversationContextDto,
  ConversationStatsDto,
  ConversationStatus,
  CustomerCannedResponseDto,
  InboxChannel,
  InboxPageDto,
  MessageSettingsDto,
  UpdateConversationInput,
  UpdateMessageSettingsInput,
  UpsertCannedResponseInput,
} from '@storageos/shared';

export interface InboxFilters {
  channel: InboxChannel;
  status?: ConversationStatus | undefined;
  mine: boolean;
  search: string;
  facilityId?: string | undefined;
}

/** Bandeja de todos los canales, por páginas. */
export function useInbox(filters: InboxFilters) {
  return useInfiniteQuery({
    queryKey: ['messages', 'inbox', filters] as const,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => {
      const qs = new URLSearchParams({ channel: filters.channel });
      if (filters.status) qs.set('status', filters.status);
      if (filters.mine) qs.set('mine', '1');
      if (filters.search) qs.set('search', filters.search);
      if (filters.facilityId) qs.set('facilityId', filters.facilityId);
      if (pageParam) qs.set('cursor', pageParam);
      return apiFetch<InboxPageDto>(`/customer-messages/inbox?${qs.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: liveRefetchInterval(),
    refetchIntervalInBackground: false,
  });
}

export function useConversationContext(customerId: string) {
  return useQuery({
    queryKey: ['messages', 'context', customerId] as const,
    queryFn: () => apiFetch<ConversationContextDto>(`/customers/${customerId}/messages/context`),
  });
}

export function useUpdateConversation(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateConversationInput) =>
      apiFetch<ConversationContextDto>(`/customers/${customerId}/messages/conversation`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(['messages', 'context', customerId], data);
      void qc.invalidateQueries({ queryKey: ['messages', 'inbox'] });
    },
  });
}

export function useConversationStats(days: number) {
  return useQuery({
    queryKey: ['messages', 'stats', days] as const,
    queryFn: () => apiFetch<ConversationStatsDto>(`/customer-messages/stats?days=${days}`),
  });
}

export function useBroadcastMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BroadcastMessageInput) =>
      apiFetch<{ sent: number; skipped: number }>('/customer-messages/broadcast', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['messages', 'inbox'] }),
  });
}

const cannedKey = ['messages', 'canned'] as const;

export function useCannedResponses() {
  return useQuery({
    queryKey: cannedKey,
    queryFn: () => apiFetch<CustomerCannedResponseDto[]>('/customer-messages/canned'),
    staleTime: 60_000,
  });
}

export function useSaveCannedResponse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpsertCannedResponseInput & { id?: string }) =>
      apiFetch<CustomerCannedResponseDto>(`/customer-messages/canned${id ? `/${id}` : ''}`, {
        method: id ? 'PATCH' : 'POST',
        json: input,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: cannedKey }),
  });
}

export function useDeleteCannedResponse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/customer-messages/canned/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: cannedKey }),
  });
}

export function useMessageSettings() {
  return useQuery({
    queryKey: ['messages', 'settings'] as const,
    queryFn: () => apiFetch<MessageSettingsDto>('/customer-messages/settings'),
  });
}

export function useUpdateMessageSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMessageSettingsInput) =>
      apiFetch<MessageSettingsDto>('/customer-messages/settings', { method: 'PUT', json: input }),
    onSuccess: (data) => qc.setQueryData(['messages', 'settings'], data),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  UpdateWhatsappSettingsInput,
  WhatsappConversationDetailDto,
  WhatsappConversationDto,
  WhatsappMessageDto,
  WhatsappSettingsDto,
  WhatsappTestResultDto,
} from '@storageos/shared';

const settingsKey = ['settings', 'whatsapp'] as const;
const conversationsKey = ['whatsapp', 'conversations'] as const;

export function useWhatsappSettings() {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => apiFetch<WhatsappSettingsDto>('/settings/whatsapp'),
  });
}

export function useUpdateWhatsappSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWhatsappSettingsInput) =>
      apiFetch<WhatsappSettingsDto>('/settings/whatsapp', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKey }),
  });
}

export function useTestWhatsapp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<WhatsappTestResultDto>('/settings/whatsapp/test', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKey }),
  });
}

export function useWhatsappConversations(enabled = true) {
  return useQuery({
    queryKey: conversationsKey,
    queryFn: () => apiFetch<WhatsappConversationDto[]>('/whatsapp/conversations'),
    enabled,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

export function useWhatsappConversation(id: string | null) {
  return useQuery({
    queryKey: [...conversationsKey, id] as const,
    queryFn: () => apiFetch<WhatsappConversationDetailDto>(`/whatsapp/conversations/${id}`),
    enabled: !!id,
    refetchInterval: 8_000,
    refetchIntervalInBackground: false,
  });
}

/** Mensajes sin leer (badge del menú). */
export function useWhatsappUnreadCount(enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'unread-count'] as const,
    queryFn: () => apiFetch<{ count: number }>('/whatsapp/conversations/unread-count'),
    enabled,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useSendWhatsappMessage(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      apiFetch<WhatsappMessageDto>(`/whatsapp/conversations/${conversationId}/messages`, {
        method: 'POST',
        json: { body },
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: conversationsKey }),
  });
}

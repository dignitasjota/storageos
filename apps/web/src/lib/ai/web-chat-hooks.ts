import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  UpdateWebChatSettingsInput,
  WebChatConversationDto,
  WebChatMessageDto,
  WebChatSettingsDto,
  WebChatStatsDto,
} from '@storageos/shared';

const settingsKey = ['web-chat', 'settings'] as const;

/** Chat con IA de la web pública: si está activo, indicaciones y respuestas del mes. */
export function useWebChatSettings() {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => apiFetch<WebChatSettingsDto>('/web-chat/settings'),
  });
}

export function useUpdateWebChatSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWebChatSettingsInput) =>
      apiFetch<WebChatSettingsDto>('/web-chat/settings', { method: 'PATCH', json: input }),
    onSuccess: (data) => qc.setQueryData(settingsKey, data),
  });
}

export function useWebChatStats(days: number) {
  return useQuery({
    queryKey: ['web-chat', 'stats', days],
    queryFn: () => apiFetch<WebChatStatsDto>(`/web-chat/stats?days=${days}`),
  });
}

export function useWebChatConversations(days: number) {
  return useQuery({
    queryKey: ['web-chat', 'conversations', days],
    queryFn: () => apiFetch<WebChatConversationDto[]>(`/web-chat/conversations?days=${days}`),
  });
}

export function useWebChatMessages(id: string | null) {
  return useQuery({
    queryKey: ['web-chat', 'conversation', id],
    queryFn: () => apiFetch<WebChatMessageDto[]>(`/web-chat/conversations/${id}`),
    enabled: !!id,
  });
}

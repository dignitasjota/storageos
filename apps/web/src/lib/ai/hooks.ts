import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AiConversationDetailDto,
  AiConversationDto,
  ChatInput,
  ChatResultDto,
  SuggestReplyResultDto,
} from '@storageos/shared';

const listKey = ['ai', 'conversations'] as const;
const detailKey = (id: string) => ['ai', 'conversations', id] as const;

export function useAiConversations() {
  return useQuery({
    queryKey: listKey,
    queryFn: () => apiFetch<AiConversationDto[]>('/ai/conversations'),
  });
}

export function useAiConversation(id: string | null) {
  return useQuery({
    queryKey: detailKey(id ?? ''),
    queryFn: () => apiFetch<AiConversationDetailDto>(`/ai/conversations/${id}`),
    enabled: !!id,
  });
}

export function useAiChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChatInput) =>
      apiFetch<ChatResultDto>('/ai/chat', { method: 'POST', json: input }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.invalidateQueries({ queryKey: detailKey(data.conversationId) });
    },
  });
}

/** Redacta (sin enviar) una respuesta para el chat con un inquilino. */
export function useSuggestReply() {
  return useMutation({
    mutationFn: (customerId: string) =>
      apiFetch<SuggestReplyResultDto>('/ai/suggest-reply', {
        method: 'POST',
        json: { customerId },
      }),
  });
}

export function useDeleteConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/ai/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AiConversationDetailDto,
  AiConversationDto,
  ChatInput,
  ChatResultDto,
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

export function useDeleteConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/ai/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
}

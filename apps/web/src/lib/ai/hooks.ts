import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AiConversationDetailDto,
  AiScheduledQuestionDto,
  CreateAiScheduledQuestionInput,
  UpdateAiScheduledQuestionInput,
  AiConversationDto,
  AiPendingActionDto,
  AiUsageDto,
  ChatInput,
  ChatResultDto,
  SuggestReplyResultDto,
  TenantAiSettingsDto,
  TenantAiTestDto,
  TestTenantAiSettingsInput,
  UpdateTenantAiSettingsInput,
} from '@storageos/shared';

export const aiConversationsKey = ['ai', 'conversations'] as const;
const listKey = aiConversationsKey;
const detailKey = (id: string) => ['ai', 'conversations', id] as const;

export const aiUsageKey = ['ai', 'usage'] as const;

/** Consultas del asistente usadas este mes (y las tuyas hoy). */
export function useAiUsage(enabled = true) {
  return useQuery({
    queryKey: aiUsageKey,
    queryFn: () => apiFetch<AiUsageDto>('/ai/usage'),
    enabled,
  });
}

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

/** Confirmar / descartar una acción propuesta por el asistente. */
export function useAiActionDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'confirm' | 'discard' }) =>
      apiFetch<AiPendingActionDto>(`/ai/actions/${id}/${decision}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiConversationsKey }),
  });
}

const aiSettingsKey = ['ai', 'settings'] as const;

/** Clave de IA propia del negocio (Configuración → Asistente IA). */
export function useTenantAiSettings(enabled = true) {
  return useQuery({
    queryKey: aiSettingsKey,
    queryFn: () => apiFetch<TenantAiSettingsDto>('/ai/settings'),
    enabled,
  });
}

export function useUpdateTenantAiSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantAiSettingsInput) =>
      apiFetch<TenantAiSettingsDto>('/ai/settings', { method: 'PUT', json: input }),
    onSuccess: (data) => {
      qc.setQueryData(aiSettingsKey, data);
      void qc.invalidateQueries({ queryKey: aiUsageKey });
    },
  });
}

/** Prueba la clave escrita (si llega) o la guardada. */
export function useTestTenantAiSettings() {
  return useMutation({
    mutationFn: (input: TestTenantAiSettingsInput = {}) =>
      apiFetch<TenantAiTestDto>('/ai/settings/test', { method: 'POST', json: input }),
  });
}

/** Preguntas para empezar según lo que pasa hoy. */
export function useAiSuggestions() {
  return useQuery({
    queryKey: ['ai', 'suggestions'],
    queryFn: () => apiFetch<string[]>('/ai/suggestions'),
    staleTime: 5 * 60_000,
  });
}

const scheduledKey = ['ai', 'scheduled-questions'] as const;

export function useAiScheduledQuestions(enabled = true) {
  return useQuery({
    queryKey: scheduledKey,
    queryFn: () => apiFetch<AiScheduledQuestionDto[]>('/ai/scheduled-questions'),
    enabled,
  });
}

export function useCreateAiScheduledQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAiScheduledQuestionInput) =>
      apiFetch<AiScheduledQuestionDto>('/ai/scheduled-questions', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scheduledKey }),
  });
}

export function useUpdateAiScheduledQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateAiScheduledQuestionInput & { id: string }) =>
      apiFetch<AiScheduledQuestionDto>(`/ai/scheduled-questions/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scheduledKey }),
  });
}

export function useDeleteAiScheduledQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/ai/scheduled-questions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scheduledKey }),
  });
}

export function useSendAiScheduledQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AiScheduledQuestionDto>(`/ai/scheduled-questions/${id}/send`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scheduledKey });
      void qc.invalidateQueries({ queryKey: listKey });
      void qc.invalidateQueries({ queryKey: aiUsageKey });
    },
  });
}

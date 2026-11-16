import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { usePagedList } from '../pagination';

import type {
  UpdateWebChatSettingsInput,
  WebChatConversationDto,
  WebChatMessageDto,
  WebChatMode,
  WebChatPendingDto,
  WebChatSettingsDto,
  WebChatStatsDto,
  WebChatTryInput,
  WebChatTryResultDto,
} from '@storageos/shared';

const settingsKey = ['web-chat', 'settings'] as const;

/** Chat con IA de la web pública: si está activo, indicaciones y respuestas del mes. */
export function useWebChatSettings(enabled = true) {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => apiFetch<WebChatSettingsDto>('/web-chat/settings'),
    enabled,
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

export function useWebChatStats(days: number, enabled = true) {
  return useQuery({
    queryKey: ['web-chat', 'stats', days],
    queryFn: () => apiFetch<WebChatStatsDto>(`/web-chat/stats?days=${days}`),
    enabled,
  });
}

/** Una conversación (la que abre un aviso aunque no esté en la lista cargada). */
export function useWebChatConversation(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['web-chat', 'conversation-info', id],
    queryFn: () => apiFetch<WebChatConversationDto>(`/web-chat/conversations/${id}/info`),
    enabled: enabled && !!id,
    retry: false,
  });
}

/** Quien puede responder la abre: sus mensajes quedan leídos (menú y «Hoy»). */
export function useWebChatMarkRead(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>(`/web-chat/conversations/${id}/read`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['web-chat', 'pending'] });
      void qc.invalidateQueries({ queryKey: ['web-chat', 'page'] });
    },
  });
}

/** Borra una conversación (p. ej. si el visitante lo pide). */
export function useDeleteWebChatConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/web-chat/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['web-chat'] }),
  });
}

/** Conversaciones del periodo, 50 por página con «Cargar más». */
export function useWebChatConversations(days: number, mode?: WebChatMode, enabled = true) {
  return usePagedList<WebChatConversationDto>(
    'web-chat',
    '/web-chat/conversations',
    { days: String(days), ...(mode ? { mode } : {}) },
    // Se refresca para ver a los visitantes que esperan a una persona.
    { enabled, refetchInterval: 30_000 },
  );
}

/** Conversaciones esperando a una persona y mensajes sin leer (menú y bandeja). */
export function useWebChatPending(enabled = true) {
  return useQuery({
    queryKey: ['web-chat', 'pending'],
    queryFn: () => apiFetch<WebChatPendingDto>('/web-chat/pending'),
    enabled,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useWebChatReply(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      apiFetch<WebChatMessageDto[]>(`/web-chat/conversations/${id}/messages`, {
        method: 'POST',
        json: { body },
      }),
    onSuccess: (data) => {
      qc.setQueryData(['web-chat', 'conversation', id], data);
      void qc.invalidateQueries({ queryKey: ['web-chat'] });
    },
  });
}

export function useWebChatSetMode(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: WebChatMode) =>
      apiFetch<{ mode: WebChatMode }>(`/web-chat/conversations/${id}`, {
        method: 'PATCH',
        json: { mode },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['web-chat'] }),
  });
}

/** Quién del equipo lleva la conversación (null: nadie). */
export function useWebChatAssign(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assignedToUserId: string | null) =>
      apiFetch<{ mode: WebChatMode }>(`/web-chat/conversations/${id}`, {
        method: 'PATCH',
        json: { assignedToUserId },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['web-chat'] }),
  });
}

/** Probar el asistente desde Configuración (no guarda nada). */
export function useWebChatTry() {
  return useMutation({
    mutationFn: (input: WebChatTryInput) =>
      apiFetch<WebChatTryResultDto>('/web-chat/try', { method: 'POST', json: input }),
  });
}

export function useWebChatSuggestReply(id: string) {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ suggestion: string }>(`/web-chat/conversations/${id}/suggest-reply`, {
        method: 'POST',
      }),
  });
}

export function useWebChatMessages(id: string | null) {
  return useQuery({
    queryKey: ['web-chat', 'conversation', id],
    queryFn: () => apiFetch<WebChatMessageDto[]>(`/web-chat/conversations/${id}`),
    enabled: !!id,
    // Una conversación abierta se refresca para ver lo que escribe el visitante.
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

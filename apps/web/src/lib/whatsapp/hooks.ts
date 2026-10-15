import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  SendWhatsappTemplateInput,
  WhatsappMediaUploadDto,
  WhatsappStatsDto,
  WhatsappTemplatesDto,
  WhatsappOutgoingMediaMime,
  UpdateWhatsappAssistantInput,
  UpdateWhatsappSettingsInput,
  WhatsappAiTestResultDto,
  WhatsappAssistantDto,
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

/** Resumen del WhatsApp en los últimos `days` días. */
export function useWhatsappStats(days: number) {
  return useQuery({
    queryKey: ['whatsapp', 'stats', days],
    queryFn: () => apiFetch<WhatsappStatsDto>(`/whatsapp/conversations/stats?days=${days}`),
    staleTime: 60_000,
  });
}

/** Plantillas aprobadas en Meta de la cuenta del tenant. */
export function useWhatsappTemplates(enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'templates'],
    queryFn: () => apiFetch<WhatsappTemplatesDto>('/whatsapp/conversations/templates'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Sube un archivo (foto o PDF) y lo envía en la conversación. */
export function useSendWhatsappMedia(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { file: File; caption?: string }) => {
      const mimeType = args.file.type as WhatsappOutgoingMediaMime;
      const up = await apiFetch<WhatsappMediaUploadDto>(
        `/whatsapp/conversations/${conversationId}/media/upload-url`,
        { method: 'POST', json: { mimeType, filename: args.file.name, size: args.file.size } },
      );
      const put = await fetch(up.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: args.file,
      });
      if (!put.ok) throw new Error('No se pudo subir el archivo');
      return apiFetch<WhatsappMessageDto>(`/whatsapp/conversations/${conversationId}/media`, {
        method: 'POST',
        json: {
          key: up.key,
          mimeType,
          filename: args.file.name,
          ...(args.caption ? { caption: args.caption } : {}),
        },
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: conversationsKey }),
  });
}

const assistantKey = ['settings', 'whatsapp', 'assistant'] as const;

export function useWhatsappAssistant(enabled = true) {
  return useQuery({
    queryKey: assistantKey,
    queryFn: () => apiFetch<WhatsappAssistantDto>('/settings/whatsapp/assistant'),
    enabled,
  });
}

export function useUpdateWhatsappAssistant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWhatsappAssistantInput) =>
      apiFetch<WhatsappAssistantDto>('/settings/whatsapp/assistant', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: (data) => qc.setQueryData(assistantKey, data),
  });
}

export function useTestWhatsappAssistant() {
  return useMutation({
    mutationFn: () =>
      apiFetch<WhatsappAiTestResultDto>('/settings/whatsapp/assistant/test', { method: 'POST' }),
  });
}

/** Activa o pausa el asistente en una conversación. */
export function useSetConversationAssistant(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assistantEnabled: boolean) =>
      apiFetch<WhatsappConversationDto>(`/whatsapp/conversations/${conversationId}`, {
        method: 'PATCH',
        json: { assistantEnabled },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: conversationsKey }),
  });
}

/** Mensaje con plantilla aprobada (pasadas 24 h). */
export function useSendWhatsappTemplate(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendWhatsappTemplateInput) =>
      apiFetch<WhatsappMessageDto>(`/whatsapp/conversations/${conversationId}/template`, {
        method: 'POST',
        json: input,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: conversationsKey }),
  });
}

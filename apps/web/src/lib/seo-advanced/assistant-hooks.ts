'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SistrixScope } from './sistrix-hooks';
import type {
  CreateSeoBriefInput,
  SeoAssistantActionDto,
  SeoAssistantChatInput,
  SeoAssistantChatResultDto,
  SeoAssistantConversationDetailDto,
  SeoAssistantConversationDto,
  SeoBriefDto,
  SeoBriefListItemDto,
  SeoBriefToDraftInput,
  SeoBriefToDraftResultDto,
  UpdateSeoBriefInput,
} from '@storageos/shared';

import { adminApiFetch, adminApiFetchBlob, adminApiFetchResponse } from '@/lib/admin/api';
import {
  AiStreamStoppedError,
  AiStreamUnavailableError,
  readAiChatStream,
  type AiStreamHandlers,
} from '@/lib/ai/stream';
import { ApiError, apiFetch, apiFetchBlob, apiFetchResponse } from '@/lib/auth/api';

/**
 * Asistente de SEO y briefs de contenido de un proyecto (PR 11), desde el
 * panel admin (cualquier proyecto; los de un tenant, en lectura) o desde el
 * del tenant. El mismo «ámbito» que SISTRIX, el plan y el rastreo.
 */
export type AssistantScope = SistrixScope;

type Fetcher = <T>(path: string, options?: { method?: string; json?: unknown }) => Promise<T>;

function scopeApi(scope: AssistantScope) {
  const admin = scope.kind === 'admin';
  const fetcher: Fetcher = admin ? adminApiFetch : apiFetch;
  const blob = admin ? adminApiFetchBlob : apiFetchBlob;
  const response = admin ? adminApiFetchResponse : apiFetchResponse;
  const base = admin ? `/admin/seo/projects/${scope.projectId}` : '/seo-advanced';
  const root = admin
    ? ['admin', 'seo', 'assistant', scope.projectId]
    : ['seo-advanced', 'assistant'];
  return {
    fetcher,
    blob,
    response,
    chatBase: `${base}/assistant`,
    briefsBase: `${base}/briefs`,
    conversationsKey: [...root, 'conversations'],
    briefsKey: [...root, 'briefs'],
    /** Lo que cambia al confirmar una acción: el plan, las oportunidades y las palabras. */
    related: admin
      ? [
          ['admin', 'seo', 'plan', scope.projectId],
          ['admin', 'seo', 'opportunities', scope.projectId],
          ['admin', 'seo', 'diagnostics', scope.projectId],
          ['admin', 'seo', 'sistrix', scope.projectId],
        ]
      : [
          ['seo-advanced', 'plan'],
          ['seo-advanced', 'opportunities'],
          ['seo-advanced', 'diagnostics'],
          ['seo-advanced', 'sistrix'],
        ],
  };
}

// ---------------------------------------------------------- conversaciones

export function useSeoConversations(scope: AssistantScope) {
  const { fetcher, chatBase, conversationsKey } = scopeApi(scope);
  return useQuery({
    queryKey: conversationsKey,
    queryFn: () => fetcher<SeoAssistantConversationDto[]>(`${chatBase}/conversations`),
  });
}

export function useSeoConversation(scope: AssistantScope, id: string | null) {
  const { fetcher, chatBase, conversationsKey } = scopeApi(scope);
  return useQuery({
    queryKey: [...conversationsKey, id],
    queryFn: () => fetcher<SeoAssistantConversationDetailDto>(`${chatBase}/conversations/${id}`),
    enabled: !!id,
  });
}

export function useDeleteSeoConversation(scope: AssistantScope) {
  const { fetcher, chatBase, conversationsKey } = scopeApi(scope);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<void>(`${chatBase}/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: conversationsKey }),
  });
}

/** Pregunta sin streaming (si el navegador no puede leerlo). */
export function useSeoChat(scope: AssistantScope) {
  const { fetcher, chatBase } = scopeApi(scope);
  return useMutation({
    mutationFn: (input: SeoAssistantChatInput) =>
      fetcher<SeoAssistantChatResultDto>(`${chatBase}/chat`, { method: 'POST', json: input }),
  });
}

/** Pregunta en streaming: el texto llega según se escribe. */
export async function streamSeoChat(
  scope: AssistantScope,
  input: SeoAssistantChatInput,
  handlers: AiStreamHandlers,
  signal?: AbortSignal,
): Promise<SeoAssistantChatResultDto> {
  const { response, chatBase } = scopeApi(scope);
  let res: Response;
  try {
    res = await response(`${chatBase}/chat/stream`, {
      method: 'POST',
      json: input,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted) throw new AiStreamStoppedError();
    if (err instanceof ApiError) throw err;
    throw new AiStreamUnavailableError();
  }
  return readAiChatStream<SeoAssistantChatResultDto>(res, handlers, signal);
}

export function useSeoActionDecision(scope: AssistantScope) {
  const { fetcher, chatBase, conversationsKey, related } = scopeApi(scope);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'confirm' | 'discard' }) =>
      fetcher<SeoAssistantActionDto>(`${chatBase}/actions/${id}/${decision}`, { method: 'POST' }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: conversationsKey }),
        ...related.map((k) => qc.invalidateQueries({ queryKey: k })),
      ]),
  });
}

export function useInvalidateSeoConversations(scope: AssistantScope) {
  const { conversationsKey } = scopeApi(scope);
  const qc = useQueryClient();
  return (id?: string | null) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: conversationsKey }),
      ...(id ? [qc.invalidateQueries({ queryKey: [...conversationsKey, id] })] : []),
    ]);
}

// ------------------------------------------------------------------ briefs

export function useSeoBriefs(scope: AssistantScope) {
  const { fetcher, briefsBase, briefsKey } = scopeApi(scope);
  return useQuery({
    queryKey: briefsKey,
    queryFn: () => fetcher<SeoBriefListItemDto[]>(briefsBase),
  });
}

export function useSeoBrief(scope: AssistantScope, id: string | null) {
  const { fetcher, briefsBase, briefsKey } = scopeApi(scope);
  return useQuery({
    queryKey: [...briefsKey, id],
    queryFn: () => fetcher<SeoBriefDto>(`${briefsBase}/${id}`),
    enabled: !!id,
  });
}

export function useCreateSeoBrief(scope: AssistantScope) {
  const { fetcher, briefsBase, briefsKey } = scopeApi(scope);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSeoBriefInput) =>
      fetcher<SeoBriefDto>(briefsBase, { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: briefsKey }),
  });
}

export function useUpdateSeoBrief(scope: AssistantScope) {
  const { fetcher, briefsBase, briefsKey } = scopeApi(scope);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateSeoBriefInput & { id: string }) =>
      fetcher<SeoBriefDto>(`${briefsBase}/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: briefsKey }),
  });
}

export function useDeleteSeoBrief(scope: AssistantScope) {
  const { fetcher, briefsBase, briefsKey } = scopeApi(scope);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher<void>(`${briefsBase}/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: briefsKey }),
  });
}

export function useSeoBriefToDraft(scope: AssistantScope) {
  const { fetcher, briefsBase, briefsKey, related } = scopeApi(scope);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: SeoBriefToDraftInput & { id: string }) =>
      fetcher<SeoBriefToDraftResultDto>(`${briefsBase}/${id}/draft`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: briefsKey }),
        ...related.map((k) => qc.invalidateQueries({ queryKey: k })),
      ]),
  });
}

/** Descarga el brief en Markdown. */
export async function downloadSeoBrief(scope: AssistantScope, id: string, title: string) {
  const { blob, briefsBase } = scopeApi(scope);
  const file = await blob(`${briefsBase}/${id}/markdown`);
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${
    title
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'brief'
  }.md`;
  a.click();
  URL.revokeObjectURL(url);
}

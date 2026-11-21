import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, apiFetch } from '../auth/api';
import { liveRefetchInterval } from '../realtime/store';

import type {
  AddTicketMessageInput,
  RateTicketInput,
  CreateSupportTicketInput,
  PageDto,
  SupportTicketDto,
  MessageAttachmentUploadDto,
  ServiceStatusDto,
  SupportResponseTimesDto,
  SupportTeammateDto,
  SupportTicketListFilter,
  SupportTicketPriorityValue,
  SupportTicketWatcherDto,
  TenantPlatformMessagesPageDto,
} from '@storageos/shared';

/**
 * Hooks de soporte para la vista TENANT (`/support`).
 * Usan el `apiFetch` con el access token del usuario del tenant.
 */

export const supportTicketsKey = ['support', 'tickets'] as const;

export function useSupportTickets() {
  return useQuery({
    queryKey: supportTicketsKey,
    queryFn: () => apiFetch<SupportTicketDto[]>('/support/tickets'),
  });
}

export interface SupportTicketFilters {
  status?: SupportTicketListFilter | undefined;
  mine?: boolean | undefined;
  search?: string | undefined;
}

/** Los tickets del tenant por páginas («Cargar más»), con filtros en el servidor. */
export function useSupportTicketsPage(filters: SupportTicketFilters = {}) {
  return useInfiniteQuery({
    queryKey: [...supportTicketsKey, 'page', filters] as const,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => {
      const qs = new URLSearchParams();
      if (pageParam) qs.set('cursor', pageParam);
      if (filters.status) qs.set('status', filters.status);
      if (filters.mine) qs.set('mine', '1');
      if (filters.search?.trim()) qs.set('search', filters.search.trim());
      const q = qs.toString();
      return apiFetch<PageDto<SupportTicketDto>>(`/support/tickets/page${q ? `?${q}` : ''}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Estado del servicio que publica TrasterOS (aviso arriba si hay una incidencia). */
export function useServiceStatus() {
  return useQuery({
    queryKey: ['support', 'service-status'] as const,
    queryFn: () => apiFetch<ServiceStatusDto>('/support/service-status'),
    refetchInterval: 120_000,
  });
}

/** Lo que solemos tardar en responder según la prioridad. */
export function useSupportResponseTimes() {
  return useQuery({
    queryKey: ['support', 'response-times'] as const,
    queryFn: () => apiFetch<SupportResponseTimesDto>('/support/response-times'),
    staleTime: 10 * 60_000,
  });
}

/** Compañeros del negocio que se pueden poner en copia. */
export function useSupportTeammates(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['support', 'teammates'] as const,
    queryFn: () => apiFetch<SupportTeammateDto[]>('/support/teammates'),
    staleTime: 5 * 60_000,
  });
}

/** Reabrir un ticket cerrado (unos días tras el cierre). */
export function useReopenTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<SupportTicketDto>(`/support/tickets/${id}/reopen`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: supportTicketsKey }),
  });
}

/** Cambiar la prioridad del ticket. */
export function useUpdateTicketPriority(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (priority: SupportTicketPriorityValue) =>
      apiFetch<SupportTicketDto>(`/support/tickets/${id}`, {
        method: 'PATCH',
        json: { priority },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: supportTicketsKey }),
  });
}

/** Sustituir la lista de compañeros en copia. */
export function useSetTicketWatchers(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userIds: string[]) =>
      apiFetch<SupportTicketWatcherDto[]>(`/support/tickets/${id}/watchers`, {
        method: 'PUT',
        json: { userIds },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['support', 'tickets', id] }),
  });
}

/** Nº de tickets con una respuesta sin leer — para el badge del menú (sondea cada 60 s). */
export function useSupportWaitingCount() {
  return useQuery({
    queryKey: ['support', 'waiting-count'] as const,
    queryFn: () => apiFetch<{ count: number }>('/support/tickets/waiting-count'),
    refetchInterval: 60_000,
  });
}

export function useSupportTicket(id: string | undefined) {
  return useQuery({
    queryKey: ['support', 'tickets', id] as const,
    queryFn: () => apiFetch<SupportTicketDto>(`/support/tickets/${id}`),
    enabled: Boolean(id),
    // Un ticket que no existe no va a aparecer por reintentar.
    retry: (count, err) =>
      !(err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500) && count < 3,
    refetchInterval: liveRefetchInterval(),
    refetchIntervalInBackground: false,
  });
}

/** El tenant da el ticket por terminado. */
export function useCloseTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<SupportTicketDto>(`/support/tickets/${id}/close`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: supportTicketsKey }),
  });
}

export function useRateTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RateTicketInput) =>
      apiFetch<SupportTicketDto>(`/support/tickets/${id}/rating`, { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: supportTicketsKey }),
  });
}

export function useCreateSupportTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSupportTicketInput) =>
      apiFetch<SupportTicketDto>('/support/tickets', { method: 'POST', json: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: supportTicketsKey });
    },
  });
}

export function useAddTicketMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: AddTicketMessageInput }) =>
      apiFetch<SupportTicketDto>(`/support/tickets/${args.id}/messages`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['support', 'tickets', vars.id] });
      qc.invalidateQueries({ queryKey: supportTicketsKey });
    },
  });
}

/** Mensajes de TrasterOS al tenant (correo directo, anuncios, retención). */
export function usePlatformMessages(enabled = true) {
  return useInfiniteQuery({
    enabled,
    queryKey: ['support', 'platform-messages'] as const,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiFetch<TenantPlatformMessagesPageDto>(
        `/support/platform-messages${pageParam ? `?cursor=${pageParam}` : ''}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Mensajes de TrasterOS sin leer por esta persona (se suman al aviso del menú «Soporte»). */
export function usePlatformMessagesUnreadCount(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ['support', 'platform-messages', 'unread-count'] as const,
    queryFn: () => apiFetch<{ count: number }>('/support/platform-messages/unread-count'),
    refetchInterval: 60_000,
  });
}

/** Al abrir la pestaña, todos los mensajes de TrasterOS quedan leídos. */
export function useMarkPlatformMessagesRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>('/support/platform-messages/read', { method: 'POST', json: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['support', 'platform-messages'] }),
  });
}

/** URL firmada para subir un adjunto a un ticket. */
export function presignTicketAttachment(mimeType: string) {
  return apiFetch<MessageAttachmentUploadDto>('/support/tickets/attachments/upload-url', {
    method: 'POST',
    json: { mimeType },
  });
}

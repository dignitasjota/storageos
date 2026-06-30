import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AddTicketMessageInput,
  CreateSupportTicketInput,
  SupportTicketDto,
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

/** Nº de tickets esperando tu respuesta — para el badge del menú (sondea cada 60 s). */
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

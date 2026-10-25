import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateLeadActivityInput,
  CreateLeadFollowupInput,
  LeadActivityDto,
  LeadDuplicateGroupDto,
  LeadFollowupDto,
  LeadResponseStatsDto,
  LeadSettingsDto,
  UpdateLeadSettingsInput,
} from '@storageos/shared';

/** Todo cuelga de `['leads', …]`: las mutaciones de contactos lo refrescan. */
const key = (...parts: string[]) => ['leads', 'crm', ...parts] as const;

export function useLeadFollowups(leadId: string) {
  return useQuery({
    queryKey: key('followups', leadId),
    queryFn: () => apiFetch<LeadFollowupDto[]>(`/leads/${leadId}/followups`),
  });
}

export function usePendingLeadFollowups() {
  return useQuery({
    queryKey: key('followups', 'pending'),
    queryFn: () => apiFetch<LeadFollowupDto[]>('/leads/followups/pending'),
  });
}

export function useCreateLeadFollowup(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLeadFollowupInput) =>
      apiFetch<LeadFollowupDto>(`/leads/${leadId}/followups`, { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads', 'crm', 'followups'] }),
  });
}

export function useUpdateLeadFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; status: 'pending' | 'done' }) =>
      apiFetch<LeadFollowupDto>(`/leads/followups/${args.id}`, {
        method: 'PATCH',
        json: { status: args.status },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['leads', 'crm', 'followups'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useDeleteLeadFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/leads/followups/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads', 'crm', 'followups'] }),
  });
}

export function useLeadActivities(leadId: string) {
  return useQuery({
    queryKey: key('activities', leadId),
    queryFn: () => apiFetch<LeadActivityDto[]>(`/leads/${leadId}/activities`),
  });
}

export function useCreateLeadActivity(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLeadActivityInput) =>
      apiFetch<LeadActivityDto>(`/leads/${leadId}/activities`, { method: 'POST', json: input }),
    // Una llamada pasa el contacto a «Contactado»: se refresca también el kanban.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export function useDeleteLeadActivity(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/leads/${leadId}/activities/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('activities', leadId) }),
  });
}

export function useLeadSettings() {
  return useQuery({
    queryKey: key('settings'),
    queryFn: () => apiFetch<LeadSettingsDto>('/leads/settings'),
  });
}

export function useUpdateLeadSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateLeadSettingsInput) =>
      apiFetch<LeadSettingsDto>('/leads/settings', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads', 'crm'] }),
  });
}

export function useLeadResponseStats(days: number) {
  return useQuery({
    queryKey: key('response-stats', String(days)),
    queryFn: () => apiFetch<LeadResponseStatsDto>(`/leads/response-stats?days=${days}`),
  });
}

export function useLeadDuplicates() {
  return useQuery({
    queryKey: key('duplicates'),
    queryFn: () => apiFetch<LeadDuplicateGroupDto[]>('/leads/duplicates'),
  });
}

export function useMergeLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { sourceId: string; intoLeadId: string }) =>
      apiFetch<void>(`/leads/${args.sourceId}/merge`, {
        method: 'POST',
        json: { intoLeadId: args.intoLeadId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });
}

export function useLinkLeadCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { leadId: string; customerId: string }) =>
      apiFetch<void>(`/leads/${args.leadId}/link-customer`, {
        method: 'POST',
        json: { customerId: args.customerId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });
}

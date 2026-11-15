import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateLeadActivityInput,
  CreateLeadFollowupInput,
  CreateLeadVisitInput,
  LeadActivityDto,
  LeadDuplicateGroupDto,
  LeadFollowupDto,
  LeadFunnelReportDto,
  LeadQuoteRecordDto,
  LeadResponseStatsDto,
  LeadSettingsDto,
  LeadSummaryDto,
  LeadTimelineItemDto,
  LeadVisitDto,
  UpdateFollowupInput,
  UpdateLeadSettingsInput,
  UpdateLeadVisitInput,
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
    mutationFn: ({ id, ...input }: { id: string } & UpdateFollowupInput) =>
      apiFetch<LeadFollowupDto>(`/leads/followups/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['leads', 'crm'] });
      void qc.invalidateQueries({ queryKey: ['followups'] });
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

/** Borra el contacto y sus datos (derecho al olvido). */
export function useDeleteLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/leads/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });
}

/** Filtros del tablero (la misma forma que la lista). */
export interface LeadBoardFilters {
  mine?: boolean;
  assignedToUserId?: string;
  source?: string;
  facilityId?: string;
  from?: string;
  to?: string;
  search?: string;
}

export function leadFilterQuery(f: LeadBoardFilters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.mine) q.assignedToUserId = 'me';
  else if (f.assignedToUserId) q.assignedToUserId = f.assignedToUserId;
  if (f.source) q.source = f.source;
  if (f.facilityId) q.facilityId = f.facilityId;
  if (f.from) q.from = f.from;
  if (f.to) q.to = f.to;
  if (f.search) q.search = f.search;
  return q;
}

export function useLeadSummary(f: LeadBoardFilters) {
  const qs = new URLSearchParams(leadFilterQuery(f)).toString();
  return useQuery({
    queryKey: key('summary', qs),
    queryFn: () => apiFetch<LeadSummaryDto>(`/leads/summary${qs ? `?${qs}` : ''}`),
  });
}

export function useLeadReport(from: string, to: string) {
  return useQuery({
    queryKey: key('report', from, to),
    queryFn: () => apiFetch<LeadFunnelReportDto>(`/leads/report?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
}

export function useLeadTimeline(leadId: string) {
  return useQuery({
    queryKey: key('timeline', leadId),
    queryFn: () => apiFetch<LeadTimelineItemDto[]>(`/leads/${leadId}/timeline`),
  });
}

export function useLeadQuotes(leadId: string) {
  return useQuery({
    queryKey: key('quotes', leadId),
    queryFn: () => apiFetch<LeadQuoteRecordDto[]>(`/leads/${leadId}/quotes`),
  });
}

export function useLeadVisits(leadId: string) {
  return useQuery({
    queryKey: key('visits', leadId),
    queryFn: () => apiFetch<LeadVisitDto[]>(`/leads/${leadId}/visits`),
  });
}

export function useCreateLeadVisit(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLeadVisitInput) =>
      apiFetch<LeadVisitDto>(`/leads/${leadId}/visits`, { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}

export function useUpdateLeadVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdateLeadVisitInput) =>
      apiFetch<LeadVisitDto>(`/leads/visits/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['followups'] });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}

export function useDeleteLeadVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/leads/visits/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}

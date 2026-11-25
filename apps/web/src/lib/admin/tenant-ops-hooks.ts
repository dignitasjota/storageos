import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  AdminAtRiskOverviewDto,
  AdminExpiredTrialDto,
  AdminFollowupInboxDto,
  AdminFollowupItemDto,
  AdminFollowupKind,
  AdminFollowupTab,
  AdminFollowupsOverdueCountDto,
  AdminOpportunitiesOverviewDto,
  AdminOpportunityDismissalDto,
  AdminSearchResultDto,
  AdminTrialFilter,
  AdminTrialsPageDto,
  BulkAdminFollowupsInput,
  BulkAdminFollowupsResultDto,
  BulkProposeAddonInput,
  BulkProposePreviewDto,
  BulkProposeResultDto,
  CreateAdminFollowupInput,
  DismissAddonOpportunityInput,
  HandOffOpportunityInput,
  HandOffOpportunityResultDto,
  PlatformLeadListDto,
  RetentionPlaybookPreviewDto,
  RetentionPlaybookReason,
  UpdateAdminFollowupInput,
} from '@storageos/shared';

// ---------------------------------------------------------------- seguimientos

export interface FollowupInboxQuery {
  tab: AdminFollowupTab;
  search: string;
  /** Id de un super admin, `none` (sin asignar), `mine` o vacío. */
  assignedTo: string;
  kind: AdminFollowupKind | '';
}

function inboxQueryString(q: FollowupInboxQuery): string {
  const p = new URLSearchParams({ tab: q.tab });
  if (q.search.trim()) p.set('search', q.search.trim());
  if (q.assignedTo === 'mine') p.set('mine', '1');
  else if (q.assignedTo) p.set('assignedTo', q.assignedTo);
  if (q.kind) p.set('kind', q.kind);
  return p.toString();
}

export function useFollowupInbox(q: FollowupInboxQuery) {
  return useQuery({
    queryKey: ['admin', 'followups', 'inbox', q] as const,
    queryFn: () =>
      adminApiFetch<AdminFollowupInboxDto>(`/admin/followups/inbox?${inboxQueryString(q)}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/** Atrasados asignados a mí o sin asignar (aviso del menú). */
export function useFollowupsOverdueCount(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'followups', 'overdue-count'] as const,
    queryFn: () => adminApiFetch<AdminFollowupsOverdueCountDto>('/admin/followups/overdue-count'),
    enabled,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });
}

/** Tras tocar seguimientos: la bandeja, el aviso, las fichas y «Hoy». */
function useInvalidateFollowups() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'followups'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'leads'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'today'] });
  };
}

export function useCreateAdminFollowup() {
  const invalidate = useInvalidateFollowups();
  return useMutation({
    mutationFn: (input: CreateAdminFollowupInput) =>
      adminApiFetch<AdminFollowupItemDto>('/admin/followups', { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateAdminFollowup() {
  const invalidate = useInvalidateFollowups();
  return useMutation({
    mutationFn: (args: { kind: AdminFollowupKind; id: string; input: UpdateAdminFollowupInput }) =>
      adminApiFetch<AdminFollowupItemDto>(`/admin/followups/items/${args.kind}/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: invalidate,
  });
}

export function useBulkAdminFollowups() {
  const invalidate = useInvalidateFollowups();
  return useMutation({
    mutationFn: (input: BulkAdminFollowupsInput) =>
      adminApiFetch<BulkAdminFollowupsResultDto>('/admin/followups/bulk', {
        method: 'POST',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteAdminFollowup() {
  const invalidate = useInvalidateFollowups();
  return useMutation({
    mutationFn: (args: { kind: AdminFollowupKind; id: string }) =>
      adminApiFetch<void>(
        args.kind === 'tenant'
          ? `/admin/followups/${args.id}`
          : `/admin/leads/followups/${args.id}`,
        { method: 'DELETE' },
      ),
    onSuccess: invalidate,
  });
}

/** Buscador de tenants y leads para crear un seguimiento. */
export function useFollowupSubjectSearch(kind: AdminFollowupKind, term: string) {
  const q = term.trim();
  return useQuery({
    queryKey: ['admin', 'followups', 'subject-search', kind, q] as const,
    queryFn: async () => {
      if (kind === 'tenant') {
        const res = await adminApiFetch<AdminSearchResultDto>(
          `/admin/search?q=${encodeURIComponent(q)}`,
        );
        return res.tenants.map((t) => ({ id: t.id, name: t.name, hint: `/${t.slug}` }));
      }
      const res = await adminApiFetch<PlatformLeadListDto>(
        `/admin/leads/list?search=${encodeURIComponent(q)}&limit=8`,
      );
      return res.items.map((l) => ({
        id: l.id,
        name: l.companyName || l.contactName || l.email || 'Lead',
        hint: l.email ?? '',
      }));
    },
    enabled: q.length >= 2,
    staleTime: 30_000,
  });
}

// ----------------------------------------------------------------------- trials

export interface TrialsQuery {
  search: string;
  filter: AdminTrialFilter;
  salesRepId: string;
  page: number;
}

export function useTrialsPage(q: TrialsQuery) {
  const p = new URLSearchParams({ filter: q.filter, page: String(q.page) });
  if (q.search.trim()) p.set('search', q.search.trim());
  if (q.salesRepId) p.set('salesRepId', q.salesRepId);
  return useQuery({
    queryKey: ['admin', 'trials', 'page', q] as const,
    queryFn: () => adminApiFetch<AdminTrialsPageDto>(`/admin/trials?${p.toString()}`),
    placeholderData: keepPreviousData,
  });
}

export function useExpiredTrials(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'trials', 'expired'] as const,
    queryFn: () => adminApiFetch<AdminExpiredTrialDto[]>('/admin/trials/expired'),
    enabled,
  });
}

// -------------------------------------------------------------------- en riesgo

export function useAtRiskOverview() {
  return useQuery({
    queryKey: ['admin', 'at-risk', 'overview'] as const,
    queryFn: () => adminApiFetch<AdminAtRiskOverviewDto>('/admin/tenants/at-risk'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function usePlaybookPreview(
  tenantId: string | null,
  reason: RetentionPlaybookReason | null,
  message: string,
) {
  return useQuery({
    queryKey: ['admin', 'at-risk', 'playbook-preview', tenantId, reason, message] as const,
    queryFn: () =>
      adminApiFetch<RetentionPlaybookPreviewDto>(
        `/admin/tenants/${tenantId}/retention-playbook/preview`,
        {
          method: 'POST',
          json: { ...(reason ? { reason } : {}), ...(message.trim() ? { message } : {}) },
        },
      ),
    enabled: !!tenantId,
    placeholderData: keepPreviousData,
  });
}

export function useLaunchPlaybook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      tenantId: string;
      reason: RetentionPlaybookReason | null;
      message: string;
    }) =>
      adminApiFetch<{ followupId: string; emailRecipients: number }>(
        `/admin/tenants/${args.tenantId}/retention-playbook`,
        {
          method: 'POST',
          json: {
            ...(args.reason ? { reason: args.reason } : {}),
            ...(args.message.trim() ? { message: args.message.trim() } : {}),
          },
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'at-risk'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'followups'] });
    },
  });
}

// --------------------------------------------------------------- oportunidades

export function useOpportunitiesOverview() {
  return useQuery({
    queryKey: ['admin', 'opportunities', 'overview'] as const,
    queryFn: () => adminApiFetch<AdminOpportunitiesOverviewDto>('/admin/opportunities/overview'),
  });
}

function useInvalidateOpportunities() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['admin', 'opportunities'] });
}

export function useDismissOpportunity() {
  const invalidate = useInvalidateOpportunities();
  return useMutation({
    mutationFn: (input: DismissAddonOpportunityInput) =>
      adminApiFetch<AdminOpportunityDismissalDto>('/admin/opportunities/dismissals', {
        method: 'POST',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useUndismissOpportunity() {
  const invalidate = useInvalidateOpportunities();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/opportunities/dismissals/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useBulkProposePreview(
  addonId: string | null,
  tenantIds: string[],
  trialDays?: number,
) {
  return useQuery({
    queryKey: ['admin', 'opportunities', 'bulk-preview', addonId, tenantIds, trialDays] as const,
    queryFn: () =>
      adminApiFetch<BulkProposePreviewDto>('/admin/opportunities/bulk-propose/preview', {
        method: 'POST',
        json: { addonId, tenantIds, ...(trialDays ? { trialDays } : {}) },
      }),
    placeholderData: keepPreviousData,
    enabled: !!addonId && tenantIds.length > 0,
    staleTime: 0,
  });
}

export function useBulkPropose() {
  const invalidate = useInvalidateOpportunities();
  return useMutation({
    mutationFn: (input: BulkProposeAddonInput) =>
      adminApiFetch<BulkProposeResultDto>('/admin/opportunities/bulk-propose', {
        method: 'POST',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useHandOffOpportunity() {
  const invalidate = useInvalidateOpportunities();
  return useMutation({
    mutationFn: (input: HandOffOpportunityInput) =>
      adminApiFetch<HandOffOpportunityResultDto>('/admin/opportunities/hand-off', {
        method: 'POST',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

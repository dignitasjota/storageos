import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch, adminApiFetchBlob } from './api';

import type {
  AdminCreateTenantInput,
  CreatePlatformLeadActivityInput,
  CreatePlatformLeadFollowupInput,
  CreatePlatformLeadInput,
  LosePlatformLeadInput,
  MovePlatformLeadInput,
  PlatformLeadBoardDto,
  PlatformLeadDetailDto,
  PlatformLeadFollowupDto,
  PlatformLeadsQuery,
  PlatformLeadStatsDto,
  SendAdminQuoteInput,
  SendPlatformLeadEmailInput,
  UpdatePlatformLeadFollowupInput,
  UpdatePlatformLeadInput,
} from '@storageos/shared';

const ROOT = ['admin', 'leads'] as const;

function queryString(q: PlatformLeadsQuery): string {
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.source) params.set('source', q.source);
  if (q.assignedTo) params.set('assignedTo', q.assignedTo);
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function useAdminLeads(q: PlatformLeadsQuery) {
  return useQuery({
    queryKey: [...ROOT, 'board', q] as const,
    queryFn: () => adminApiFetch<PlatformLeadBoardDto>(`/admin/leads${queryString(q)}`),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useAdminLead(id: string | null) {
  return useQuery({
    queryKey: [...ROOT, 'detail', id] as const,
    queryFn: () => adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}`),
    enabled: !!id,
  });
}

export function useAdminLeadStats(months: number) {
  return useQuery({
    queryKey: [...ROOT, 'stats', months] as const,
    queryFn: () => adminApiFetch<PlatformLeadStatsDto>(`/admin/leads/stats?months=${months}`),
  });
}

export function useAdminLeadFollowups(mine: boolean) {
  return useQuery({
    queryKey: [...ROOT, 'followups', mine ? 'mine' : 'all'] as const,
    queryFn: () =>
      adminApiFetch<PlatformLeadFollowupDto[]>(`/admin/leads/followups${mine ? '?mine=1' : ''}`),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/** Descarga el CSV de los leads con los mismos filtros que el tablero. */
export async function downloadLeadsCsv(q: PlatformLeadsQuery): Promise<void> {
  const blob = await adminApiFetchBlob(`/admin/leads/export.csv${queryString(q)}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'leads.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/** Tras cualquier cambio: el tablero, la ficha, los seguimientos y «Hoy». */
function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ROOT });
    void qc.invalidateQueries({ queryKey: ['admin', 'today'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'quote-offers'] });
  };
}

/** Mutación sobre un lead que devuelve su ficha actualizada. */
function useLeadAction<TVars>(request: (vars: TVars) => Promise<PlatformLeadDetailDto>) {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: request,
    onSuccess: (lead) => {
      qc.setQueryData([...ROOT, 'detail', lead.id], lead);
      invalidate();
    },
  });
}

export function useCreateLead() {
  return useLeadAction((input: CreatePlatformLeadInput) =>
    adminApiFetch<PlatformLeadDetailDto>('/admin/leads', { method: 'POST', json: input }),
  );
}

export function useUpdateLead() {
  return useLeadAction(({ id, input }: { id: string; input: UpdatePlatformLeadInput }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}`, { method: 'PATCH', json: input }),
  );
}

export function useMoveLead() {
  return useLeadAction(({ id, input }: { id: string; input: MovePlatformLeadInput }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/move`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useLoseLead() {
  return useLeadAction(({ id, input }: { id: string; input: LosePlatformLeadInput }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/lose`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useReopenLead() {
  return useLeadAction((id: string) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/reopen`, { method: 'POST' }),
  );
}

export function useLeadActivity() {
  return useLeadAction(({ id, input }: { id: string; input: CreatePlatformLeadActivityInput }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/activities`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useDeleteLeadActivity() {
  return useLeadAction(({ id, activityId }: { id: string; activityId: string }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/activities/${activityId}`, {
      method: 'DELETE',
    }),
  );
}

export function useCreateLeadFollowup() {
  return useLeadAction(({ id, input }: { id: string; input: CreatePlatformLeadFollowupInput }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/followups`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSendLeadEmail() {
  return useLeadAction(({ id, input }: { id: string; input: SendPlatformLeadEmailInput }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/email`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useLinkLeadTenant() {
  return useLeadAction(({ id, tenantId }: { id: string; tenantId: string }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/link`, {
      method: 'POST',
      json: { tenantId },
    }),
  );
}

export function useCreateLeadTenant() {
  const qc = useQueryClient();
  const action = useLeadAction(({ id, input }: { id: string; input: AdminCreateTenantInput }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/create-tenant`, {
      method: 'POST',
      json: input,
    }),
  );
  return {
    ...action,
    mutateAsync: async (vars: { id: string; input: AdminCreateTenantInput }) => {
      const res = await action.mutateAsync(vars);
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      return res;
    },
  };
}

export function useSendLeadQuote() {
  return useLeadAction(({ id, input }: { id: string; input: SendAdminQuoteInput }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/quote`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useDiscardLead() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/leads/${id}/discard`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useDeleteLead() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => adminApiFetch<void>(`/admin/leads/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useUpdateLeadFollowup() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePlatformLeadFollowupInput }) =>
      adminApiFetch<PlatformLeadFollowupDto>(`/admin/leads/followups/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteLeadFollowup() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/leads/followups/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

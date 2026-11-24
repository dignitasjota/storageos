import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../auth/api';

import { adminApiFetch, adminApiFetchBlob } from './api';

import type {
  AdminCreateTenantInput,
  CheckPlatformLeadDuplicatesInput,
  DiscardPlatformLeadInput,
  ImportCommitDto,
  ImportPreviewDto,
  MessageAttachmentUploadDto,
  PlatformLeadBulkInput,
  PlatformLeadBulkResultDto,
  PlatformLeadCaptureInput,
  PlatformLeadDuplicateDto,
  PlatformLeadImportInput,
  PlatformLeadListDto,
  PlatformLeadListQuery,
  PlatformLeadSequenceDto,
  PlatformLeadSettingsDto,
  PlatformLeadSource,
  SalesTemplateDto,
  SetPlatformLeadSequenceInput,
  UpdatePlatformLeadSettingsInput,
  UpsertPlatformLeadSequenceInput,
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
  if (q.discarded) params.set('discarded', '1');
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function useAdminLeads(q: PlatformLeadsQuery, enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'board', q] as const,
    queryFn: () => adminApiFetch<PlatformLeadBoardDto>(`/admin/leads${queryString(q)}`),
    enabled,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useAdminLead(id: string | null) {
  return useQuery({
    queryKey: [...ROOT, 'detail', id] as const,
    queryFn: () => adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}`),
    enabled: !!id,
    // Un lead borrado no va a volver: sin reintentos (la ficha lo dice al momento).
    retry: (count, err) => !(err instanceof ApiError && err.statusCode === 404) && count < 2,
  });
}

export function useAdminLeadStats(months: number, source: PlatformLeadSource | null = null) {
  return useQuery({
    queryKey: [...ROOT, 'stats', months, source] as const,
    queryFn: () =>
      adminApiFetch<PlatformLeadStatsDto>(
        `/admin/leads/stats?months=${months}${source ? `&source=${source}` : ''}`,
      ),
  });
}

/** Filtros de la vista de lista (sin orden ni página), para la URL y las vistas guardadas. */
export type LeadListFilters = Omit<PlatformLeadListQuery, 'sort' | 'dir' | 'cursor' | 'limit'>;

function listQueryString(
  f: LeadListFilters,
  sort: PlatformLeadListQuery['sort'],
  dir: PlatformLeadListQuery['dir'],
  cursor: string | null,
  limit = 50,
): string {
  const p = new URLSearchParams();
  if (f.search) p.set('search', f.search);
  if (f.source) p.set('source', f.source);
  if (f.assignedTo) p.set('assignedTo', f.assignedTo);
  if (f.status?.length) p.set('status', f.status.join(','));
  if (f.sizeMin !== undefined) p.set('sizeMin', String(f.sizeMin));
  if (f.sizeMax !== undefined) p.set('sizeMax', String(f.sizeMax));
  if (f.city) p.set('city', f.city);
  if (f.campaign) p.set('campaign', f.campaign);
  if (f.batch) p.set('batch', f.batch);
  if (f.noSalesRep) p.set('noSalesRep', '1');
  if (f.inactiveDays) p.set('inactiveDays', String(f.inactiveDays));
  if (f.stale) p.set('stale', '1');
  if (f.discarded) p.set('discarded', '1');
  p.set('sort', sort);
  p.set('dir', dir);
  p.set('limit', String(limit));
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

/** Vista de lista: una página (con `cursor`, la siguiente). */
export function useAdminLeadList(
  f: LeadListFilters,
  sort: PlatformLeadListQuery['sort'],
  dir: PlatformLeadListQuery['dir'],
  cursor: string | null,
) {
  return useQuery({
    queryKey: [...ROOT, 'list', f, sort, dir, cursor] as const,
    queryFn: () =>
      adminApiFetch<PlatformLeadListDto>(
        `/admin/leads/list?${listQueryString(f, sort, dir, cursor)}`,
      ),
    placeholderData: (prev) => prev,
  });
}

export function useLeadsBulk() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: PlatformLeadBulkInput) =>
      adminApiFetch<PlatformLeadBulkResultDto>('/admin/leads/bulk', {
        method: 'POST',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

/** Descarga el CSV de los leads elegidos. */
export async function downloadSelectedLeadsCsv(ids: string[]): Promise<void> {
  const blob = await adminApiFetchBlob(`/admin/leads/export.csv?ids=${ids.join(',')}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'leads-seleccion.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export function useLeadSettings() {
  return useQuery({
    queryKey: [...ROOT, 'settings'] as const,
    queryFn: () => adminApiFetch<PlatformLeadSettingsDto>('/admin/leads/settings'),
  });
}

export function useUpdateLeadSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformLeadSettingsInput) =>
      adminApiFetch<PlatformLeadSettingsDto>('/admin/leads/settings', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData([...ROOT, 'settings'], data);
      void qc.invalidateQueries({ queryKey: ROOT });
    },
  });
}

export function useLeadSequences() {
  return useQuery({
    queryKey: [...ROOT, 'sequences'] as const,
    queryFn: () => adminApiFetch<PlatformLeadSequenceDto[]>('/admin/leads/sequences'),
  });
}

export function useSaveLeadSequence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: UpsertPlatformLeadSequenceInput }) =>
      adminApiFetch<PlatformLeadSequenceDto>(
        id ? `/admin/leads/sequences/${id}` : '/admin/leads/sequences',
        { method: id ? 'PATCH' : 'POST', json: input },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...ROOT, 'sequences'] }),
  });
}

export function useDeleteLeadSequence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/leads/sequences/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...ROOT, 'sequences'] }),
  });
}

/** Plantillas de correo (las de «Materiales y plantillas»). */
export function useLeadTemplates() {
  return useQuery({
    queryKey: [...ROOT, 'templates'] as const,
    queryFn: () => adminApiFetch<SalesTemplateDto[]>('/admin/leads/templates'),
    staleTime: 5 * 60_000,
  });
}

export function checkLeadDuplicates(
  input: CheckPlatformLeadDuplicatesInput,
): Promise<PlatformLeadDuplicateDto[]> {
  return adminApiFetch<PlatformLeadDuplicateDto[]>('/admin/leads/duplicates', {
    method: 'POST',
    json: input,
  });
}

export function useMergeLead() {
  return useLeadAction(({ id, sourceId }: { id: string; sourceId: string }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/merge`, {
      method: 'POST',
      json: { sourceId },
    }),
  );
}

export function useSetLeadSequence() {
  return useLeadAction(({ id, input }: { id: string; input: SetPlatformLeadSequenceInput }) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/sequence`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function leadAttachmentUploadUrl(
  id: string,
  mimeType: string,
): Promise<MessageAttachmentUploadDto> {
  return adminApiFetch<MessageAttachmentUploadDto>(`/admin/leads/${id}/attachments/upload-url`, {
    method: 'POST',
    json: { mimeType },
  });
}

export function useImportLeads() {
  const invalidate = useInvalidate();
  return {
    preview: (input: PlatformLeadImportInput) =>
      adminApiFetch<ImportPreviewDto>('/admin/leads/import/preview', {
        method: 'POST',
        json: input,
      }),
    commit: async (input: PlatformLeadImportInput) => {
      const res = await adminApiFetch<ImportCommitDto>('/admin/leads/import/commit', {
        method: 'POST',
        json: input,
      });
      invalidate();
      return res;
    },
  };
}

/** Captura rápida (también la usan los comerciales). */
export async function captureLead(
  input: Omit<PlatformLeadCaptureInput, 'photoKey'>,
  photo: File | null,
): Promise<{ leadId: string }> {
  let photoKey: string | undefined;
  if (photo) {
    const up = await adminApiFetch<{
      uploadUrl: string;
      key: string;
      requiredHeaders: Record<string, string>;
    }>('/admin/leads/capture/photo-upload-url', { method: 'POST', json: { mimeType: photo.type } });
    const put = await fetch(up.uploadUrl, {
      method: 'PUT',
      headers: up.requiredHeaders,
      body: photo,
    });
    if (!put.ok) throw new Error('upload_failed');
    photoKey = up.key;
  }
  return adminApiFetch<{ leadId: string }>('/admin/leads/capture', {
    method: 'POST',
    json: { ...input, ...(photoKey ? { photoKey } : {}) },
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
    mutationFn: ({ id, input }: { id: string; input: DiscardPlatformLeadInput }) =>
      adminApiFetch<void>(`/admin/leads/${id}/discard`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

/** Recupera un lead marcado «No es un lead». */
export function useRestoreLead() {
  return useLeadAction((id: string) =>
    adminApiFetch<PlatformLeadDetailDto>(`/admin/leads/${id}/restore`, { method: 'POST' }),
  );
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

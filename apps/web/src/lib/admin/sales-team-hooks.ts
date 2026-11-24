'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  AssignSalesAccountInput,
  CreateSalesCommissionItemInput,
  CreateSalesRepInput,
  CreateSalesSettlementInput,
  ImpersonationTokenDto,
  MovePlatformLeadInput,
  SalesArchiveLeadInput,
  SalesDirectionNoteInput,
  SalesDirectionReassignInput,
  SalesPortfolioDetailDto,
  SalesPortfolioListDto,
  SalesPortfolioRowDto,
  SalesPortfoliosQuery,
  UpdateSalesProfileInput,
  SalesDemoPortalLinkDto,
  PlatformSalesSettingsDto,
  ReassignSalesPortfolioInput,
  SalesAccountRepDto,
  SalesAddonClaimDto,
  SalesBatchDto,
  SalesBulkImportInput,
  SalesDistributeLeadsInput,
  SalesDistributionResultDto,
  SalesCadenceDto,
  SalesCommissionItemDto,
  SalesCommissionPlanDto,
  SalesMaterialDto,
  SalesMaterialUploadInput,
  SalesPendingAssignmentDto,
  SalesRepAccountsDto,
  SalesRepDetailDto,
  SalesSettlementDto,
  SalesTargetDto,
  SalesTeamComparisonDto,
  SalesTeamDto,
  SalesTeamForecastDto,
  SalesTemplateDto,
  UpdatePlatformSalesSettingsInput,
  UpdateSalesCommissionPlanInput,
  UpdateSalesRepInput,
  UpsertSalesCadenceInput,
  UpsertSalesCommissionConceptInput,
  UpsertSalesMaterialInput,
  UpsertSalesTargetInput,
  UpsertSalesTemplateInput,
} from '@storageos/shared';

const ROOT = ['admin', 'sales-team'] as const;

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ROOT });
  };
}

export function useSalesTeam(enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'overview'] as const,
    queryFn: () => adminApiFetch<SalesTeamDto>('/admin/sales-team'),
    enabled,
  });
}

export function useSalesTeamPendingCount(enabled: boolean) {
  return useQuery({
    queryKey: [...ROOT, 'pending-count'] as const,
    queryFn: () => adminApiFetch<{ count: number }>('/admin/sales-team/pending-count'),
    enabled,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });
}

export function usePendingAssignments() {
  return useQuery({
    queryKey: [...ROOT, 'pending-assignments'] as const,
    queryFn: () =>
      adminApiFetch<SalesPendingAssignmentDto[]>('/admin/sales-team/pending-assignments'),
  });
}

export function useSalesRep(id: string) {
  return useQuery({
    queryKey: [...ROOT, 'rep', id] as const,
    queryFn: () => adminApiFetch<SalesRepDetailDto>(`/admin/sales-team/reps/${id}`),
  });
}

export function useSalesRepAccounts(id: string) {
  return useQuery({
    queryKey: [...ROOT, 'rep', id, 'accounts'] as const,
    queryFn: () => adminApiFetch<SalesRepAccountsDto>(`/admin/sales-team/reps/${id}/accounts`),
  });
}

export function useTeamClaims(status?: string) {
  return useQuery({
    queryKey: [...ROOT, 'claims', status ?? 'all'] as const,
    queryFn: () =>
      adminApiFetch<SalesAddonClaimDto[]>(
        `/admin/sales-team/claims${status ? `?status=${status}` : ''}`,
      ),
  });
}

export function useTeamCommissions(f: { repId?: string; month?: string; status?: string }) {
  const p = new URLSearchParams();
  if (f.repId) p.set('repId', f.repId);
  if (f.month) p.set('month', f.month);
  if (f.status) p.set('status', f.status);
  const s = p.toString();
  return useQuery({
    queryKey: [...ROOT, 'commissions', f] as const,
    queryFn: () =>
      adminApiFetch<SalesCommissionItemDto[]>(`/admin/sales-team/commissions${s ? `?${s}` : ''}`),
  });
}

export function useTeamForecast() {
  return useQuery({
    queryKey: [...ROOT, 'forecast'] as const,
    queryFn: () => adminApiFetch<SalesTeamForecastDto>('/admin/sales-team/forecast'),
  });
}

export function useTeamComparison(months: number) {
  return useQuery({
    queryKey: [...ROOT, 'comparison', months] as const,
    queryFn: () =>
      adminApiFetch<SalesTeamComparisonDto>(`/admin/sales-team/comparison?months=${months}`),
  });
}

export function useTeamSettlements(repId?: string) {
  return useQuery({
    queryKey: [...ROOT, 'settlements', repId ?? 'all'] as const,
    queryFn: () =>
      adminApiFetch<SalesSettlementDto[]>(
        `/admin/sales-team/settlements${repId ? `?repId=${repId}` : ''}`,
      ),
  });
}

export function useSalesSettings() {
  return useQuery({
    queryKey: [...ROOT, 'settings'] as const,
    queryFn: () => adminApiFetch<PlatformSalesSettingsDto>('/admin/sales-team/settings'),
  });
}

export function useTeamMaterials() {
  return useQuery({
    queryKey: [...ROOT, 'materials'] as const,
    queryFn: () => adminApiFetch<SalesMaterialDto[]>('/admin/sales-team/materials'),
  });
}

export function useTeamTemplates() {
  return useQuery({
    queryKey: [...ROOT, 'templates'] as const,
    queryFn: () => adminApiFetch<SalesTemplateDto[]>('/admin/sales-team/templates'),
  });
}

export function useTeamCadences() {
  return useQuery({
    queryKey: [...ROOT, 'cadences'] as const,
    queryFn: () => adminApiFetch<SalesCadenceDto[]>('/admin/sales-team/cadences'),
  });
}

/** Comercial de una cuenta (ficha del tenant). */
export function useAccountRep(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'account', tenantId] as const,
    queryFn: () =>
      adminApiFetch<SalesAccountRepDto>(`/admin/sales-team/accounts?tenantId=${tenantId}`),
    enabled,
    retry: false,
  });
}

function useTeamMutation<TVars, TRes>(request: (vars: TVars) => Promise<TRes>) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: request, onSuccess: invalidate });
}

export function useCreateSalesRep() {
  return useTeamMutation((input: CreateSalesRepInput) =>
    adminApiFetch<SalesRepDetailDto>('/admin/sales-team/reps', { method: 'POST', json: input }),
  );
}

export function useUpdateSalesRep(id: string) {
  return useTeamMutation((input: UpdateSalesRepInput) =>
    adminApiFetch<SalesRepDetailDto>(`/admin/sales-team/reps/${id}`, {
      method: 'PATCH',
      json: input,
    }),
  );
}

export function useSetSalesRepActive(id: string) {
  return useTeamMutation((isActive: boolean) =>
    adminApiFetch(`/admin/super-admins/${id}/active`, { method: 'PATCH', json: { isActive } }),
  );
}

export function useSaveSalesPlan(id: string) {
  return useTeamMutation((input: UpdateSalesCommissionPlanInput) =>
    adminApiFetch<SalesCommissionPlanDto>(`/admin/sales-team/reps/${id}/plan`, {
      method: 'PUT',
      json: input,
    }),
  );
}

export function useSaveSalesConcept(id: string) {
  return useTeamMutation(
    ({
      conceptId,
      input,
    }: {
      conceptId: string | null;
      input: UpsertSalesCommissionConceptInput;
    }) =>
      adminApiFetch<SalesCommissionPlanDto>(
        conceptId
          ? `/admin/sales-team/reps/${id}/concepts/${conceptId}`
          : `/admin/sales-team/reps/${id}/concepts`,
        { method: conceptId ? 'PATCH' : 'POST', json: input },
      ),
  );
}

export function useDeleteSalesConcept(id: string) {
  return useTeamMutation((conceptId: string) =>
    adminApiFetch<SalesCommissionPlanDto>(`/admin/sales-team/reps/${id}/concepts/${conceptId}`, {
      method: 'DELETE',
    }),
  );
}

export function useSaveSalesTarget(id: string) {
  return useTeamMutation((input: UpsertSalesTargetInput) =>
    adminApiFetch<SalesTargetDto[]>(`/admin/sales-team/reps/${id}/targets`, {
      method: 'PUT',
      json: input,
    }),
  );
}

export function useAssignSalesAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignSalesAccountInput) =>
      adminApiFetch<{ ok: true }>('/admin/sales-team/assign', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ROOT });
      void qc.invalidateQueries({ queryKey: ['admin', 'leads'] });
    },
  });
}

export function useReassignPortfolio(id: string) {
  return useTeamMutation((input: ReassignSalesPortfolioInput) =>
    adminApiFetch<{ moved: number }>(`/admin/sales-team/reps/${id}/reassign`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useDecideClaim() {
  return useTeamMutation(({ id, approve, note }: { id: string; approve: boolean; note?: string }) =>
    adminApiFetch<SalesAddonClaimDto>(
      `/admin/sales-team/claims/${id}/${approve ? 'approve' : 'reject'}`,
      {
        method: 'POST',
        json: note ? { note } : {},
      },
    ),
  );
}

export function useDecideItem() {
  return useTeamMutation(({ id, approve, note }: { id: string; approve: boolean; note?: string }) =>
    adminApiFetch<SalesCommissionItemDto>(
      `/admin/sales-team/commissions/items/${id}/${approve ? 'approve' : 'reject'}`,
      { method: 'POST', json: note ? { note } : {} },
    ),
  );
}

export function useCreateCommissionItem() {
  return useTeamMutation((input: CreateSalesCommissionItemInput) =>
    adminApiFetch<SalesCommissionItemDto>('/admin/sales-team/commissions/items', {
      method: 'POST',
      json: input,
    }),
  );
}

export function useRecalculateCommissions() {
  return useTeamMutation(() =>
    adminApiFetch<{ claims: number; created: number }>(
      '/admin/sales-team/commissions/recalculate',
      {
        method: 'POST',
      },
    ),
  );
}

export function useCreateSettlement() {
  return useTeamMutation((input: CreateSalesSettlementInput) =>
    adminApiFetch<SalesSettlementDto>('/admin/sales-team/settlements', {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSettlementPaid() {
  return useTeamMutation((id: string) =>
    adminApiFetch<SalesSettlementDto>(`/admin/sales-team/settlements/${id}/paid`, {
      method: 'POST',
    }),
  );
}

export function useSaveSalesSettings() {
  return useTeamMutation((input: UpdatePlatformSalesSettingsInput) =>
    adminApiFetch<PlatformSalesSettingsDto>('/admin/sales-team/settings', {
      method: 'PUT',
      json: input,
    }),
  );
}

export function useDemoAction() {
  return useTeamMutation((action: 'create' | 'reset') =>
    adminApiFetch<PlatformSalesSettingsDto>(
      action === 'create' ? '/admin/sales-team/demo' : '/admin/sales-team/demo/reset',
      { method: 'POST' },
    ),
  );
}

export function useOpenDemoPortalAsAdmin() {
  return useMutation({
    mutationFn: () =>
      adminApiFetch<SalesDemoPortalLinkDto>('/admin/sales-team/demo/portal', { method: 'POST' }),
  });
}

export function useOpenDemoAsAdmin() {
  return useMutation({
    mutationFn: () =>
      adminApiFetch<ImpersonationTokenDto>('/admin/sales-team/demo/open', { method: 'POST' }),
  });
}

export function useSaveMaterial() {
  return useTeamMutation(({ id, input }: { id: string | null; input: UpsertSalesMaterialInput }) =>
    adminApiFetch<SalesMaterialDto>(
      id ? `/admin/sales-team/materials/${id}` : '/admin/sales-team/materials',
      {
        method: id ? 'PATCH' : 'POST',
        json: input,
      },
    ),
  );
}

export function useDeleteMaterial() {
  return useTeamMutation((id: string) =>
    adminApiFetch<void>(`/admin/sales-team/materials/${id}`, { method: 'DELETE' }),
  );
}

/** Sube un fichero de material: pide la URL firmada y lo sube directo. */
export async function uploadSalesMaterial(file: File): Promise<{ key: string; fileName: string }> {
  const input: SalesMaterialUploadInput = {
    fileName: file.name,
    mimeType: file.type as SalesMaterialUploadInput['mimeType'],
    sizeBytes: file.size,
  };
  const { uploadUrl, key } = await adminApiFetch<{ uploadUrl: string; key: string }>(
    '/admin/sales-team/materials/upload-url',
    { method: 'POST', json: input },
  );
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  });
  if (!res.ok) throw new Error('No se ha podido subir el fichero');
  return { key, fileName: file.name };
}

export function useSaveTemplate() {
  return useTeamMutation(({ id, input }: { id: string | null; input: UpsertSalesTemplateInput }) =>
    adminApiFetch<SalesTemplateDto>(
      id ? `/admin/sales-team/templates/${id}` : '/admin/sales-team/templates',
      {
        method: id ? 'PATCH' : 'POST',
        json: input,
      },
    ),
  );
}

export function useDeleteTemplate() {
  return useTeamMutation((id: string) =>
    adminApiFetch<void>(`/admin/sales-team/templates/${id}`, { method: 'DELETE' }),
  );
}

export function useSaveCadence() {
  return useTeamMutation(({ id, input }: { id: string | null; input: UpsertSalesCadenceInput }) =>
    adminApiFetch<SalesCadenceDto>(
      id ? `/admin/sales-team/cadences/${id}` : '/admin/sales-team/cadences',
      {
        method: id ? 'PATCH' : 'POST',
        json: input,
      },
    ),
  );
}

export function useDeleteCadence() {
  return useTeamMutation((id: string) =>
    adminApiFetch<void>(`/admin/sales-team/cadences/${id}`, { method: 'DELETE' }),
  );
}

// ------------------------------------------------------- reparto masivo

/** Importar un fichero y repartirlo (con `commit: false`, solo la vista previa). */
export function useDistributeImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<SalesBulkImportInput, 'commit'> & { commit: boolean }) =>
      adminApiFetch<SalesDistributionResultDto>('/admin/sales-team/distribute/import', {
        method: 'POST',
        json: input,
      }),
    onSuccess: (res) => {
      if (!res.committed) return;
      void qc.invalidateQueries({ queryKey: ROOT });
      void qc.invalidateQueries({ queryKey: ['admin', 'leads'] });
    },
  });
}

/** Repartir leads de la lista (con `commit: false`, solo la vista previa). */
export function useDistributeLeads() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<SalesDistributeLeadsInput, 'commit'> & { commit: boolean }) =>
      adminApiFetch<SalesDistributionResultDto>('/admin/sales-team/distribute/leads', {
        method: 'POST',
        json: input,
      }),
    onSuccess: (res) => {
      if (!res.committed) return;
      void qc.invalidateQueries({ queryKey: ROOT });
      void qc.invalidateQueries({ queryKey: ['admin', 'leads'] });
    },
  });
}

/** Lotes repartidos y en qué fase están sus prospectos. */
export function useSalesBatches(enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'batches'] as const,
    queryFn: () => adminApiFetch<SalesBatchDto[]>('/admin/sales-team/batches'),
    enabled,
  });
}

// ---------------------------------------------------------------- carteras

/** Filtros de Carteras tal como van en la URL (sin el cursor ni el tamaño). */
export type SalesPortfoliosParams = Partial<
  Record<Exclude<keyof SalesPortfoliosQuery, 'cursor' | 'limit'>, string>
>;

function portfoliosQs(
  params: SalesPortfoliosParams,
  extra: Record<string, string | undefined> = {},
) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...extra })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Prospectos y clientes de todos los comerciales, por páginas («Cargar más»). */
export function useSalesPortfolios(params: SalesPortfoliosParams, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...ROOT, 'portfolios', params] as const,
    queryFn: ({ pageParam }) =>
      adminApiFetch<SalesPortfolioListDto>(
        `/admin/sales-team/portfolios${portfoliosQs(params, {
          cursor: pageParam ?? undefined,
          limit: '50',
        })}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

/** Todas las filas con esos filtros (para el CSV). */
export function fetchSalesPortfoliosExport(
  params: SalesPortfoliosParams,
): Promise<SalesPortfolioRowDto[]> {
  return adminApiFetch<SalesPortfolioRowDto[]>(
    `/admin/sales-team/portfolios/export${portfoliosQs(params)}`,
  );
}

export function useSalesPortfolio(leadId: string | null) {
  return useQuery({
    queryKey: [...ROOT, 'portfolio', leadId] as const,
    queryFn: () => adminApiFetch<SalesPortfolioDetailDto>(`/admin/sales-team/portfolios/${leadId}`),
    enabled: !!leadId,
  });
}

/** Acciones de la dirección sobre una cuenta: refrescan la ficha y la tabla. */
function usePortfolioMutation<T>(
  leadId: string,
  run: (input: T) => Promise<SalesPortfolioDetailDto>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (detail) => {
      qc.setQueryData([...ROOT, 'portfolio', leadId], detail);
      void qc.invalidateQueries({ queryKey: [...ROOT, 'portfolios'] });
      void qc.invalidateQueries({ queryKey: [...ROOT, 'overview'] });
    },
  });
}

const portfolioPath = (leadId: string, action: string) =>
  `/admin/sales-team/portfolios/${leadId}/${action}`;

export function usePortfolioNote(leadId: string) {
  return usePortfolioMutation<SalesDirectionNoteInput>(leadId, (body) =>
    adminApiFetch(portfolioPath(leadId, 'notes'), { method: 'POST', json: body }),
  );
}

export function usePortfolioReassign(leadId: string) {
  return usePortfolioMutation<SalesDirectionReassignInput>(leadId, (body) =>
    adminApiFetch(portfolioPath(leadId, 'reassign'), { method: 'POST', json: body }),
  );
}

export function usePortfolioProfile(leadId: string) {
  return usePortfolioMutation<UpdateSalesProfileInput>(leadId, (body) =>
    adminApiFetch(portfolioPath(leadId, 'profile'), { method: 'PATCH', json: body }),
  );
}

export function usePortfolioMove(leadId: string) {
  return usePortfolioMutation<MovePlatformLeadInput>(leadId, (body) =>
    adminApiFetch(portfolioPath(leadId, 'move'), { method: 'POST', json: body }),
  );
}

export function usePortfolioArchive(leadId: string) {
  return usePortfolioMutation<SalesArchiveLeadInput>(leadId, (body) =>
    adminApiFetch(portfolioPath(leadId, 'archive'), { method: 'POST', json: body }),
  );
}

export function usePortfolioRecover(leadId: string) {
  return usePortfolioMutation<void>(leadId, () =>
    adminApiFetch(portfolioPath(leadId, 'recover'), { method: 'POST' }),
  );
}

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  AssignSalesAccountInput,
  CreateSalesCommissionItemInput,
  CreateSalesRepInput,
  CreateSalesSettlementInput,
  ImpersonationTokenDto,
  PlatformSalesSettingsDto,
  ReassignSalesPortfolioInput,
  SalesAccountRepDto,
  SalesAddonClaimDto,
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

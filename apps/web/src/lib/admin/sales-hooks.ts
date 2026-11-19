'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch, adminApiFetchBlob } from './api';

import type {
  AdminAddonOpportunityDto,
  AdminApprovalRequestDto,
  AdminQuoteDto,
  CreatePlatformLeadActivityInput,
  CreatePlatformLeadFollowupInput,
  CreateSalesProspectInput,
  ImpersonationTokenDto,
  SalesDemoPortalLinkDto,
  LosePlatformLeadInput,
  MovePlatformLeadInput,
  PlatformLeadFollowupDto,
  RequestSalesConceptInput,
  SalesAccountDto,
  SalesAccountSummaryDto,
  SalesAddonClaimDto,
  SalesAddonOfferInput,
  SalesApprovalRequestInput,
  SalesCadenceDto,
  SalesCallOutcomeInput,
  SalesClientRowDto,
  SalesCommissionsDto,
  SalesCreateTenantInput,
  SalesDemoStatusDto,
  SalesExtendTrialInput,
  SalesForecastDto,
  SalesImportResultDto,
  SalesLeadListDto,
  SalesMaterialDto,
  SalesOfferDto,
  SalesRepProfileDto,
  SalesSettlementDto,
  SalesSimulateQuoteInput,
  SalesTargetDto,
  SalesTemplateDto,
  SalesTodayDto,
  SendAdminQuoteInput,
  SendPlatformLeadEmailInput,
  SuperAdminNotificationDto,
  UpdatePlatformLeadFollowupInput,
  UpdateSalesLeadInput,
  UpdateSalesMeInput,
  UpdateSalesProfileInput,
} from '@storageos/shared';

/** Catálogo para preparar propuestas (planes, extras y cupones de comerciales). */
export interface SalesCatalogDto {
  plans: {
    id: string;
    slug: string;
    name: string;
    priceMonthly: number;
    priceYearly: number | null;
  }[];
  addons: { id: string; name: string; description: string | null; priceMonthly: number }[];
  coupons: {
    code: string;
    discountType: string;
    discountValue: number;
    validUntil: string | null;
    durationMonths: number | null;
  }[];
}

const ROOT = ['admin', 'sales'] as const;

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------- lecturas

export function useSalesMe() {
  return useQuery({
    queryKey: [...ROOT, 'me'] as const,
    queryFn: () => adminApiFetch<SalesRepProfileDto>('/admin/sales/me'),
  });
}

export function useSalesToday() {
  return useQuery({
    queryKey: [...ROOT, 'today'] as const,
    queryFn: () => adminApiFetch<SalesTodayDto>('/admin/sales/today'),
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });
}

export function useSalesLeads(q: { search?: string; status?: string; filter?: string }) {
  return useQuery({
    queryKey: [...ROOT, 'leads', q] as const,
    queryFn: () => adminApiFetch<SalesLeadListDto>(`/admin/sales/leads${qs(q)}`),
  });
}

export function useSalesClients(filter?: string) {
  return useQuery({
    queryKey: [...ROOT, 'clients', filter ?? ''] as const,
    queryFn: () => adminApiFetch<SalesClientRowDto[]>(`/admin/sales/clients${qs({ filter })}`),
  });
}

export function useSalesAccount(leadId: string | null) {
  return useQuery({
    queryKey: [...ROOT, 'account', leadId] as const,
    queryFn: () => adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}`),
    enabled: !!leadId,
  });
}

export function useSalesSummary(leadId: string, ai: boolean, enabled: boolean) {
  return useQuery({
    // Con IA va fuera de la raíz: cada acción de la ficha la refresca, y cada
    // petición al modelo cuesta. Se vuelve a pedir solo con «Actualizar».
    queryKey: ai
      ? (['admin', 'sales-ai-summary', leadId] as const)
      : ([...ROOT, 'summary', leadId, ai] as const),
    queryFn: () =>
      adminApiFetch<SalesAccountSummaryDto>(
        `/admin/sales/accounts/${leadId}/summary${ai ? '?ai=1' : ''}`,
      ),
    enabled,
    staleTime: ai ? Infinity : 60_000,
    refetchOnWindowFocus: !ai,
  });
}

export function useSalesCatalog() {
  return useQuery({
    queryKey: [...ROOT, 'catalog'] as const,
    queryFn: () => adminApiFetch<SalesCatalogDto>('/admin/sales/catalog'),
    staleTime: 300_000,
  });
}

export function useSalesOffers() {
  return useQuery({
    queryKey: [...ROOT, 'offers'] as const,
    queryFn: () => adminApiFetch<SalesOfferDto[]>('/admin/sales/offers'),
  });
}

export function useSalesOpportunities() {
  return useQuery({
    queryKey: [...ROOT, 'opportunities'] as const,
    queryFn: () => adminApiFetch<AdminAddonOpportunityDto[]>('/admin/sales/opportunities'),
  });
}

export function useSalesApprovals() {
  return useQuery({
    queryKey: [...ROOT, 'approvals'] as const,
    queryFn: () => adminApiFetch<AdminApprovalRequestDto[]>('/admin/sales/approvals'),
  });
}

export function useSalesClaims() {
  return useQuery({
    queryKey: [...ROOT, 'claims'] as const,
    queryFn: () => adminApiFetch<SalesAddonClaimDto[]>('/admin/sales/claims'),
  });
}

export function useSalesCommissions() {
  return useQuery({
    queryKey: [...ROOT, 'commissions'] as const,
    queryFn: () => adminApiFetch<SalesCommissionsDto>('/admin/sales/commissions'),
  });
}

export function useSalesSettlements() {
  return useQuery({
    queryKey: [...ROOT, 'settlements'] as const,
    queryFn: () => adminApiFetch<SalesSettlementDto[]>('/admin/sales/settlements'),
  });
}

export function useSalesForecast() {
  return useQuery({
    queryKey: [...ROOT, 'forecast'] as const,
    queryFn: () => adminApiFetch<SalesForecastDto>('/admin/sales/forecast'),
  });
}

/** Confirma que ha recibido una liquidación. */
export function useAcknowledgeSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      adminApiFetch<SalesSettlementDto>(`/admin/sales/settlements/${id}/received`, {
        method: 'POST',
        json: note ? { note } : {},
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...ROOT, 'settlements'] }),
  });
}

/** Descarga un fichero (PDF) con la sesión del panel. */
export async function downloadAdminFile(path: string, filename: string): Promise<void> {
  const blob = await adminApiFetchBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function useSalesTargets() {
  return useQuery({
    queryKey: [...ROOT, 'targets'] as const,
    queryFn: () => adminApiFetch<SalesTargetDto[]>('/admin/sales/targets'),
  });
}

export function useSalesMaterials() {
  return useQuery({
    queryKey: [...ROOT, 'materials'] as const,
    queryFn: () => adminApiFetch<SalesMaterialDto[]>('/admin/sales/materials'),
  });
}

export function useSalesTemplates() {
  return useQuery({
    queryKey: [...ROOT, 'templates'] as const,
    queryFn: () => adminApiFetch<SalesTemplateDto[]>('/admin/sales/templates'),
    staleTime: 300_000,
  });
}

export function useSalesCadences() {
  return useQuery({
    queryKey: [...ROOT, 'cadences'] as const,
    queryFn: () => adminApiFetch<SalesCadenceDto[]>('/admin/sales/cadences'),
    staleTime: 300_000,
  });
}

export function useSalesDemo() {
  return useQuery({
    queryKey: [...ROOT, 'demo'] as const,
    queryFn: () => adminApiFetch<SalesDemoStatusDto>('/admin/sales/demo'),
  });
}

export function useSalesNotifications() {
  return useInfiniteQuery({
    queryKey: [...ROOT, 'notifications', 'list'] as const,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      adminApiFetch<{ items: SuperAdminNotificationDto[]; nextCursor: string | null }>(
        `/admin/sales/notifications${pageParam ? `?cursor=${pageParam}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useSalesUnreadCount(enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'notifications', 'unread'] as const,
    queryFn: () => adminApiFetch<{ count: number }>('/admin/sales/notifications/unread-count'),
    enabled,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

// --------------------------------------------------------------- escrituras

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ROOT });
}

/** Acción sobre una cuenta que devuelve su ficha. */
function useAccountAction<TVars>(request: (vars: TVars) => Promise<SalesAccountDto>) {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: request,
    onSuccess: (account) => {
      qc.setQueryData([...ROOT, 'account', account.lead.id], account);
      invalidate();
    },
  });
}

export function useCreateProspect() {
  return useAccountAction((input: CreateSalesProspectInput) =>
    adminApiFetch<SalesAccountDto>('/admin/sales/leads', { method: 'POST', json: input }),
  );
}

export function useUpdateSalesLead(leadId: string) {
  return useAccountAction((input: UpdateSalesLeadInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}`, {
      method: 'PATCH',
      json: input,
    }),
  );
}

export function useSalesProfile(leadId: string) {
  return useAccountAction((input: UpdateSalesProfileInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/profile`, {
      method: 'PUT',
      json: input,
    }),
  );
}

export function useSalesOutcome(leadId: string) {
  return useAccountAction((input: SalesCallOutcomeInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/outcome`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSalesActivity(leadId: string) {
  return useAccountAction((input: CreatePlatformLeadActivityInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/activities`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSalesMove(leadId: string) {
  return useAccountAction((input: MovePlatformLeadInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/move`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSalesLose(leadId: string) {
  return useAccountAction((input: LosePlatformLeadInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/lose`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSalesReopen(leadId: string) {
  return useAccountAction(() =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/reopen`, { method: 'POST' }),
  );
}

export function useSalesFollowup(leadId: string) {
  return useAccountAction((input: CreatePlatformLeadFollowupInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/followups`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useUpdateSalesFollowup() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePlatformLeadFollowupInput }) =>
      adminApiFetch<PlatformLeadFollowupDto>(`/admin/sales/followups/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteSalesFollowup() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/sales/followups/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useSalesEmail(leadId: string) {
  return useAccountAction((input: SendPlatformLeadEmailInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/email`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSalesRegistrationLink(leadId: string) {
  return useAccountAction(() =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/registration-link`, {
      method: 'POST',
    }),
  );
}

export function useSalesCreateTenant(leadId: string) {
  return useAccountAction((input: SalesCreateTenantInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/create-tenant`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSalesSendQuote(leadId: string) {
  return useAccountAction((input: SendAdminQuoteInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/quote`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSalesSimulate() {
  return useMutation({
    mutationFn: (input: SalesSimulateQuoteInput) =>
      adminApiFetch<AdminQuoteDto>('/admin/sales/quote', { method: 'POST', json: input }),
  });
}

export function useSalesCadence(leadId: string) {
  return useAccountAction(({ cadenceId }: { cadenceId: string | null }) =>
    cadenceId
      ? adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/cadence`, {
          method: 'POST',
          json: { cadenceId },
        })
      : adminApiFetch<SalesAccountDto>(`/admin/sales/accounts/${leadId}/cadence`, {
          method: 'DELETE',
        }),
  );
}

export function useSalesAddonOffer(tenantId: string) {
  return useAccountAction((input: SalesAddonOfferInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/clients/${tenantId}/addon-offer`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSalesExtendTrial(tenantId: string) {
  return useAccountAction((input: SalesExtendTrialInput) =>
    adminApiFetch<SalesAccountDto>(`/admin/sales/clients/${tenantId}/extend-trial`, {
      method: 'POST',
      json: input,
    }),
  );
}

export function useSalesRequestApproval() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: SalesApprovalRequestInput) =>
      adminApiFetch<AdminApprovalRequestDto>('/admin/sales/approvals', {
        method: 'POST',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useSalesClaimNote() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, repNote }: { id: string; repNote: string }) =>
      adminApiFetch<SalesAddonClaimDto[]>(`/admin/sales/claims/${id}/note`, {
        method: 'PUT',
        json: { repNote },
      }),
    onSuccess: invalidate,
  });
}

export function useSalesRequestConcept() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: RequestSalesConceptInput) =>
      adminApiFetch<SalesCommissionsDto>('/admin/sales/commissions/concepts', {
        method: 'POST',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useSalesImport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { csv: string; commit: boolean }) =>
      adminApiFetch<SalesImportResultDto>('/admin/sales/leads/import', {
        method: 'POST',
        json: input,
      }),
    onSuccess: (res) => {
      if (res.created > 0) invalidate();
    },
  });
}

export function useUpdateSalesMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSalesMeInput) =>
      adminApiFetch<SalesRepProfileDto>('/admin/sales/me', { method: 'PATCH', json: input }),
    onSuccess: (me) => qc.setQueryData([...ROOT, 'me'], me),
  });
}

export function useOpenSalesDemoPortal() {
  return useMutation({
    mutationFn: () =>
      adminApiFetch<SalesDemoPortalLinkDto>('/admin/sales/demo/portal', { method: 'POST' }),
  });
}

export function useOpenSalesDemo() {
  return useMutation({
    mutationFn: () =>
      adminApiFetch<ImpersonationTokenDto>('/admin/sales/demo/open', { method: 'POST' }),
  });
}

export async function salesMaterialUrl(id: string): Promise<string> {
  const { url } = await adminApiFetch<{ url: string }>(`/admin/sales/materials/${id}/download`);
  return url;
}

export function useSalesMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string | null) =>
      id
        ? adminApiFetch<void>(`/admin/sales/notifications/${id}/read`, { method: 'POST' })
        : adminApiFetch<void>('/admin/sales/notifications/read-all', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...ROOT, 'notifications'] }),
  });
}

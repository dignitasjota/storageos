import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';
import { invalidateTenant } from './hooks';

import type {
  AdminAnonymizeResultDto,
  AdminSubscriptionPreviewDto,
  AdminTenantConsistencyDto,
  AdminTenantCustomersPageDto,
  AdminTenantDataExportDto,
  AdminTenantDto,
  AdminTenantDuplicateDto,
  AdminTenantEmailRecipientDto,
  AdminTenantFacilitiesPageDto,
  AnonymizeTenantInput,
  CancelTenantInput,
  ConsistencyCode,
  SubscriptionPreviewQuery,
  TenantBillingSummaryDto,
  TenantSubscriptionPaymentDto,
  UpdateTenantAddonInput,
} from '@storageos/shared';
import type { QueryClient } from '@tanstack/react-query';

function refreshTenant(qc: QueryClient, tenantId: string) {
  invalidateTenant(qc, tenantId);
  void qc.invalidateQueries({ queryKey: ['admin', 'tenants', 'overview'] });
}

/** Vista previa de una acción sobre la suscripción (solo con el diálogo abierto). */
export function useSubscriptionPreview(tenantId: string, query: SubscriptionPreviewQuery | null) {
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
  }
  return useQuery({
    queryKey: ['admin', 'tenants', tenantId, 'subscription-preview', qs.toString()] as const,
    queryFn: () =>
      adminApiFetch<AdminSubscriptionPreviewDto>(
        `/admin/tenants/${tenantId}/subscription-preview?${qs}`,
      ),
    enabled: Boolean(query),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useCancelTenant(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CancelTenantInput) =>
      adminApiFetch<AdminTenantDto>(`/admin/tenants/${tenantId}/cancel`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => refreshTenant(qc, tenantId),
  });
}

export function useUndoCancelTenant(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      adminApiFetch<AdminTenantDto>(`/admin/tenants/${tenantId}/cancel/undo`, {
        method: 'POST',
        json: { reason },
      }),
    onSuccess: () => refreshTenant(qc, tenantId),
  });
}

export function useRequestAnonymize(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AnonymizeTenantInput) =>
      adminApiFetch<AdminAnonymizeResultDto>(`/admin/tenants/${tenantId}/anonymize`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => refreshTenant(qc, tenantId),
  });
}

export function useCancelAnonymize(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      adminApiFetch<AdminTenantDto>(`/admin/tenants/${tenantId}/anonymize-schedule`, {
        method: 'DELETE',
        json: { reason },
      }),
    onSuccess: () => refreshTenant(qc, tenantId),
  });
}

export function useTenantConsistency(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'tenants', tenantId, 'consistency'] as const,
    queryFn: () =>
      adminApiFetch<AdminTenantConsistencyDto>(`/admin/tenants/${tenantId}/consistency`),
    enabled,
  });
}

export function useFixConsistency(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: ConsistencyCode) =>
      adminApiFetch<AdminTenantConsistencyDto>(
        `/admin/tenants/${tenantId}/consistency/${code}/fix`,
        { method: 'POST' },
      ),
    onSuccess: () => refreshTenant(qc, tenantId),
  });
}

export function useVoidSaasPayment(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { paymentId: string; reason: string }) =>
      adminApiFetch<TenantSubscriptionPaymentDto>(
        `/admin/tenants/${tenantId}/saas-payments/${args.paymentId}/void`,
        { method: 'POST', json: { reason: args.reason } },
      ),
    onSuccess: () => refreshTenant(qc, tenantId),
  });
}

export function useUpdateTenantAddon(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { assignmentId: string; input: UpdateTenantAddonInput }) =>
      adminApiFetch<TenantBillingSummaryDto>(
        `/admin/tenants/${tenantId}/addons/${args.assignmentId}`,
        { method: 'PATCH', json: args.input },
      ),
    onSuccess: () => refreshTenant(qc, tenantId),
  });
}

export function useChargeTenantAddonNow(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { assignmentId: string; provider: string }) =>
      adminApiFetch<TenantBillingSummaryDto>(
        `/admin/tenants/${tenantId}/addons/${args.assignmentId}/charge-now`,
        { method: 'POST', json: { provider: args.provider } },
      ),
    onSuccess: () => {
      refreshTenant(qc, tenantId);
      void qc.invalidateQueries({ queryKey: ['admin', 'today'] });
    },
  });
}

export function useChangeUserEmail(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { userId: string; email: string; reason: string }) =>
      adminApiFetch<void>(`/admin/tenants/${tenantId}/users/${args.userId}/change-email`, {
        method: 'POST',
        json: { email: args.email, reason: args.reason },
      }),
    onSuccess: () => refreshTenant(qc, tenantId),
  });
}

export function useMakeOwner(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { userId: string; reason: string }) =>
      adminApiFetch<void>(`/admin/tenants/${tenantId}/users/${args.userId}/make-owner`, {
        method: 'POST',
        json: { reason: args.reason },
      }),
    onSuccess: () => refreshTenant(qc, tenantId),
  });
}

export function useEmailRecipients(tenantId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'tenants', tenantId, 'email-recipients'] as const,
    queryFn: () =>
      adminApiFetch<AdminTenantEmailRecipientDto[]>(`/admin/tenants/${tenantId}/email-recipients`),
    enabled,
  });
}

export function useTenantDataExports(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'tenants', tenantId, 'data-exports'] as const,
    queryFn: () =>
      adminApiFetch<AdminTenantDataExportDto[]>(`/admin/tenants/${tenantId}/data-exports`),
    enabled,
    // Mientras haya una en marcha, se mira cada pocos segundos.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((e) => e.status === 'pending') ? 3000 : false,
  });
}

export function useRequestDataExport(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      adminApiFetch<AdminTenantDataExportDto>(`/admin/tenants/${tenantId}/data-export`, {
        method: 'POST',
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants', tenantId, 'data-exports'] }),
  });
}

export function downloadDataExport(tenantId: string, exportId: string) {
  return adminApiFetch<{ url: string }>(
    `/admin/tenants/${tenantId}/data-exports/${exportId}/download`,
  );
}

export function usePinInteraction(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { interactionId: string; pinned: boolean }) =>
      adminApiFetch(`/admin/tenants/${tenantId}/interactions/${args.interactionId}/pin`, {
        method: 'POST',
        json: { pinned: args.pinned },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants', tenantId, 'timeline'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants', tenantId, 'interactions'] });
    },
  });
}

export function useTenantCustomersPage(tenantId: string, search: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['admin', 'tenants', tenantId, 'customers-page', search] as const,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => {
      const qs = new URLSearchParams({ limit: '30' });
      if (search.trim()) qs.set('search', search.trim());
      if (pageParam) qs.set('cursor', pageParam);
      return adminApiFetch<AdminTenantCustomersPageDto>(
        `/admin/tenants/${tenantId}/customers/page?${qs}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useTenantFacilitiesPage(tenantId: string, search: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['admin', 'tenants', tenantId, 'facilities-page', search] as const,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => {
      const qs = new URLSearchParams({ limit: '30' });
      if (search.trim()) qs.set('search', search.trim());
      if (pageParam) qs.set('cursor', pageParam);
      return adminApiFetch<AdminTenantFacilitiesPageDto>(
        `/admin/tenants/${tenantId}/facilities/page?${qs}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useTenantDuplicates(q: { name: string; email: string }, enabled: boolean) {
  const qs = new URLSearchParams();
  if (q.name.trim().length >= 3) qs.set('name', q.name.trim());
  if (q.email.includes('@')) qs.set('email', q.email.trim());
  return useQuery({
    queryKey: ['admin', 'tenant-duplicates', qs.toString()] as const,
    queryFn: () => adminApiFetch<AdminTenantDuplicateDto[]>(`/admin/tenant-duplicates?${qs}`),
    enabled: enabled && qs.toString().length > 0,
    staleTime: 30_000,
  });
}

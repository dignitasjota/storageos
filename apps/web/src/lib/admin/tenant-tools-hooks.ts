import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  AdminAeatActionResultDto,
  AdminAnonymizePreviewDto,
  AdminCreateTenantInput,
  AdminCreateTenantResultDto,
  AdminSavedViewDto,
  AdminUserSessionDto,
  CustomDomainCheckDto,
  SnoozeRiskInput,
} from '@storageos/shared';

/** Alta manual de un tenant (venta asistida). */
export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminCreateTenantInput) =>
      adminApiFetch<AdminCreateTenantResultDto>('/admin/tenants', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] }),
  });
}

/** Lo que borraría anonimizar y lo que conviene revisar antes. */
export function useAnonymizePreview(tenantId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'tenants', tenantId, 'anonymize-preview'] as const,
    queryFn: () =>
      adminApiFetch<AdminAnonymizePreviewDto>(`/admin/tenants/${tenantId}/anonymize-preview`),
    enabled,
  });
}

/** «Ignorar» un tenant en la lista de riesgo (o volver a mostrarlo). */
export function useRiskSnooze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { tenantId: string; input: SnoozeRiskInput | null }) => {
      if (args.input) {
        await adminApiFetch<{ until: string }>(`/admin/tenants/${args.tenantId}/risk-snooze`, {
          method: 'POST',
          json: args.input,
        });
      } else {
        await adminApiFetch<void>(`/admin/tenants/${args.tenantId}/risk-snooze`, {
          method: 'DELETE',
        });
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'at-risk'] }),
  });
}

/** Comprueba ahora el DNS del dominio propio de un tenant. */
export function useCheckCustomDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) =>
      adminApiFetch<CustomDomainCheckDto>(`/admin/tenants/${tenantId}/custom-domain/check`, {
        method: 'POST',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'custom-domains'] }),
  });
}

/** Consulta o reenvía una factura de un tenant a la AEAT. */
export function useAdminAeatAction(action: 'refresh-aeat' | 'resend-aeat') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invoiceId: string) =>
      adminApiFetch<AdminAeatActionResultDto>(
        `/admin/billing-health/invoices/${invoiceId}/${action}`,
        { method: 'POST' },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'billing-health'] }),
  });
}

/** Sesiones abiertas de un usuario del tenant. */
export function useAdminUserSessions(tenantId: string, userId: string | null) {
  return useQuery({
    queryKey: ['admin', 'tenants', tenantId, 'users', userId, 'sessions'] as const,
    queryFn: () =>
      adminApiFetch<AdminUserSessionDto[]>(`/admin/tenants/${tenantId}/users/${userId}/sessions`),
    enabled: Boolean(userId),
  });
}

export function useRevokeAdminUserSession(tenantId: string, userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      adminApiFetch<void>(`/admin/tenants/${tenantId}/users/${userId}/sessions/${sessionId}`, {
        method: 'DELETE',
      }),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: ['admin', 'tenants', tenantId, 'users', userId, 'sessions'],
      }),
  });
}

const viewsKey = ['admin', 'saved-views', 'tenants'] as const;

/** Vistas guardadas de la lista de tenants (en el servidor, por super admin). */
export function useSavedViews() {
  return useQuery({
    queryKey: viewsKey,
    queryFn: () => adminApiFetch<AdminSavedViewDto[]>('/admin/saved-views?page=tenants'),
  });
}

export function useSaveView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; filters: Record<string, unknown> }) =>
      adminApiFetch<AdminSavedViewDto>('/admin/saved-views', {
        method: 'POST',
        json: { page: 'tenants', ...input },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: viewsKey }),
  });
}

export function useDeleteView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/saved-views/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: viewsKey }),
  });
}

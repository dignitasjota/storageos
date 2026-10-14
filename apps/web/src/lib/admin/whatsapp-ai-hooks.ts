import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  AdminTenantWhatsappAiDto,
  PlatformWhatsappAiDto,
  UpdateAdminTenantWhatsappAiInput,
  UpdatePlatformWhatsappAiInput,
  WhatsappAiTestResultDto,
} from '@storageos/shared';

const platformKey = ['admin', 'whatsapp-ai'] as const;

/** IA del asistente de WhatsApp de la plataforma. */
export function useAdminWhatsappAi() {
  return useQuery({
    queryKey: platformKey,
    queryFn: () => adminApiFetch<PlatformWhatsappAiDto>('/admin/whatsapp-ai'),
  });
}

export function useUpdateAdminWhatsappAi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformWhatsappAiInput) =>
      adminApiFetch<PlatformWhatsappAiDto>('/admin/whatsapp-ai', { method: 'PUT', json: input }),
    onSuccess: (data) => qc.setQueryData(platformKey, data),
  });
}

export function useTestAdminWhatsappAi() {
  return useMutation({
    mutationFn: () =>
      adminApiFetch<WhatsappAiTestResultDto>('/admin/whatsapp-ai/test', { method: 'POST' }),
  });
}

/** IA de WhatsApp de un tenant (modo y límite). */
export function useAdminTenantWhatsappAi(tenantId: string) {
  return useQuery({
    queryKey: ['admin', 'tenants', tenantId, 'whatsapp-ai'] as const,
    queryFn: () =>
      adminApiFetch<AdminTenantWhatsappAiDto>(`/admin/tenants/${tenantId}/whatsapp-ai`),
  });
}

export function useUpdateAdminTenantWhatsappAi(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAdminTenantWhatsappAiInput) =>
      adminApiFetch<AdminTenantWhatsappAiDto>(`/admin/tenants/${tenantId}/whatsapp-ai`, {
        method: 'PUT',
        json: input,
      }),
    onSuccess: (data) => qc.setQueryData(['admin', 'tenants', tenantId, 'whatsapp-ai'], data),
  });
}

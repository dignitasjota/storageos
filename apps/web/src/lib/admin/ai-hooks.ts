import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  AiConnectionTestDto,
  AiUsageDto,
  PlatformAiSettingsDto,
  PlatformAiUsageDto,
  UpdatePlatformAiSettingsInput,
  UpdateTenantAiLimitInput,
} from '@storageos/shared';

const settingsKey = ['admin', 'ai-settings'] as const;

/** Clave, modelo y límites del asistente IA del panel. */
export function useAdminAiSettings() {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => adminApiFetch<PlatformAiSettingsDto>('/admin/ai-settings'),
  });
}

export function useUpdateAdminAiSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformAiSettingsInput) =>
      adminApiFetch<PlatformAiSettingsDto>('/admin/ai-settings', { method: 'PUT', json: input }),
    onSuccess: (data) => qc.setQueryData(settingsKey, data),
  });
}

export function useTestAdminAiSettings() {
  return useMutation({
    mutationFn: (prompt?: string) =>
      adminApiFetch<AiConnectionTestDto>('/admin/ai-settings/test', {
        method: 'POST',
        json: prompt ? { prompt } : {},
      }),
  });
}

/** Uso y coste del mes con la clave de la plataforma. */
export function useAdminAiUsage() {
  return useQuery({
    queryKey: ['admin', 'ai-settings', 'usage'] as const,
    queryFn: () => adminApiFetch<PlatformAiUsageDto>('/admin/ai-settings/usage'),
  });
}

/** Consultas del asistente IA de un tenant este mes. */
export function useAdminTenantAiUsage(tenantId: string) {
  return useQuery({
    queryKey: ['admin', 'tenants', tenantId, 'ai-usage'] as const,
    queryFn: () => adminApiFetch<AiUsageDto>(`/admin/tenants/${tenantId}/ai-usage`),
  });
}

export function useUpdateAdminTenantAiLimit(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantAiLimitInput) =>
      adminApiFetch<AiUsageDto>(`/admin/tenants/${tenantId}/ai-usage`, {
        method: 'PUT',
        json: input,
      }),
    onSuccess: (data) => qc.setQueryData(['admin', 'tenants', tenantId, 'ai-usage'], data),
  });
}

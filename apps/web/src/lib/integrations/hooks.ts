import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  ApiKeyDto,
  ApiKeyWithPlaintextDto,
  CreateApiKeyInput,
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookDeliveryDto,
  WebhookDto,
  WebhookWithSecretDto,
} from '@storageos/shared';

// -------------------- API keys --------------------

export const apiKeysKey = ['settings', 'api-keys'] as const;

export function useApiKeys() {
  return useQuery({
    queryKey: apiKeysKey,
    queryFn: () => apiFetch<ApiKeyDto[]>('/settings/api-keys'),
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      apiFetch<ApiKeyWithPlaintextDto>('/settings/api-keys', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: apiKeysKey }),
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ApiKeyDto>(`/settings/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: apiKeysKey }),
  });
}

// -------------------- Webhooks --------------------

export const webhooksKey = ['settings', 'webhooks'] as const;

export function useWebhooks() {
  return useQuery({
    queryKey: webhooksKey,
    queryFn: () => apiFetch<WebhookDto[]>('/settings/webhooks'),
  });
}

export function useCreateWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWebhookInput) =>
      apiFetch<WebhookWithSecretDto>('/settings/webhooks', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: webhooksKey }),
  });
}

export function useUpdateWebhook(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWebhookInput) =>
      apiFetch<WebhookDto>(`/settings/webhooks/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: webhooksKey }),
  });
}

export function useRevokeWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<WebhookDto>(`/settings/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: webhooksKey }),
  });
}

export function useRotateWebhookSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<WebhookWithSecretDto>(`/settings/webhooks/${id}/rotate-secret`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: webhooksKey }),
  });
}

export interface WebhookDeliveriesFilters {
  status?: 'pending' | 'success' | 'failed';
  fromDate?: string;
  toDate?: string;
  cursor?: string;
  limit?: number;
}

export function webhookDeliveriesKey(
  webhookId: string | null,
  filters: WebhookDeliveriesFilters = {},
) {
  return ['settings', 'webhooks', webhookId, 'deliveries', filters] as const;
}

export function useWebhookDeliveries(
  webhookId: string | null,
  filters: WebhookDeliveriesFilters = {},
) {
  return useQuery({
    enabled: !!webhookId,
    queryKey: webhookDeliveriesKey(webhookId, filters),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', String(filters.limit ?? 50));
      if (filters.status) params.set('status', filters.status);
      if (filters.fromDate) params.set('fromDate', filters.fromDate);
      if (filters.toDate) params.set('toDate', filters.toDate);
      if (filters.cursor) params.set('cursor', filters.cursor);
      return apiFetch<{ items: WebhookDeliveryDto[]; nextCursor: string | null }>(
        `/settings/webhooks/${webhookId}/deliveries?${params.toString()}`,
      );
    },
  });
}

export function useRetryWebhookDelivery(webhookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      apiFetch<{ queued: true }>(`/settings/webhooks/${webhookId}/deliveries/${deliveryId}/retry`, {
        method: 'POST',
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['settings', 'webhooks', webhookId, 'deliveries'] }),
  });
}

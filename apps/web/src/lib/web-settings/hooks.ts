import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  UpdateWebSettingsInput,
  WebPerformanceDto,
  WebSettingsResponse,
} from '@storageos/shared';

const key = ['settings', 'web'] as const;

export function useWebSettings() {
  return useQuery({
    queryKey: key,
    queryFn: () => apiFetch<WebSettingsResponse>('/settings/tenant/web'),
  });
}

export function useUpdateWebSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWebSettingsInput) =>
      apiFetch<WebSettingsResponse>('/settings/tenant/web', { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

/** Rendimiento de la web: leads → contrato → MRR (últimos 90 días). */
export function useWebPerformance() {
  return useQuery({
    queryKey: ['analytics', 'web-performance'] as const,
    queryFn: () => apiFetch<WebPerformanceDto>('/analytics/web-performance'),
  });
}

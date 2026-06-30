import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { ResolveUnitChangeRequestInput, UnitChangeRequestDto } from '@storageos/shared';

const key = ['unit-change-requests'] as const;

export function useUnitChangeRequests(status?: string) {
  return useQuery({
    queryKey: [...key, status ?? 'all'] as const,
    queryFn: () =>
      apiFetch<UnitChangeRequestDto[]>(`/unit-change-requests${status ? `?status=${status}` : ''}`),
  });
}

/** Nº de cambios de trastero pendientes — para el badge del menú (sondea cada 60 s). */
export function useUnitChangePendingCount(enabled = true) {
  return useQuery({
    queryKey: [...key, 'pending-count'] as const,
    queryFn: () => apiFetch<{ count: number }>('/unit-change-requests/pending-count'),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useResolveUnitChangeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: ResolveUnitChangeRequestInput }) =>
      apiFetch<UnitChangeRequestDto>(`/unit-change-requests/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { ResolveUnitRequestInput, UnitRequestDto } from '@storageos/shared';

const key = ['unit-requests'] as const;

export function useUnitRequests(status?: string) {
  return useQuery({
    queryKey: [...key, status ?? 'all'] as const,
    queryFn: () => apiFetch<UnitRequestDto[]>(`/unit-requests${status ? `?status=${status}` : ''}`),
  });
}

/** Nº de solicitudes de trastero adicional pendientes — badge del menú (60 s). */
export function useUnitRequestPendingCount(enabled = true) {
  return useQuery({
    queryKey: [...key, 'pending-count'] as const,
    queryFn: () => apiFetch<{ count: number }>('/unit-requests/pending-count'),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useResolveUnitRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: ResolveUnitRequestInput }) =>
      apiFetch<UnitRequestDto>(`/unit-requests/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

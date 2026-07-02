import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { TodayDto } from '@storageos/shared';

/** Bandeja operativa «Hoy»: lo que el equipo debe atender (sondea cada 60 s). */
export function useToday(facilityId?: string) {
  const qs = facilityId ? `?facilityId=${facilityId}` : '';
  return useQuery({
    queryKey: ['dashboard', 'today', facilityId ?? null] as const,
    queryFn: () => apiFetch<TodayDto>(`/dashboard/today${qs}`),
    refetchInterval: 60_000,
  });
}

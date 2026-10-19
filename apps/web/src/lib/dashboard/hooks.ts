import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { TodayDto, TodaySummaryDto } from '@storageos/shared';

/** Bandeja operativa «Hoy»: lo que el equipo debe atender (sondea cada 60 s). */
export function useToday(facilityId?: string) {
  const qs = facilityId ? `?facilityId=${facilityId}` : '';
  return useQuery({
    queryKey: ['dashboard', 'today', facilityId ?? null] as const,
    queryFn: () => apiFetch<TodayDto>(`/dashboard/today${qs}`),
    refetchInterval: 60_000,
  });
}

/** Cifras del mes y actividad de las últimas 48 h (cabecera de «Hoy»). */
export function useTodaySummary(facilityId?: string) {
  const qs = facilityId ? `?facilityId=${facilityId}` : '';
  return useQuery({
    queryKey: ['dashboard', 'today', 'summary', facilityId ?? null] as const,
    queryFn: () => apiFetch<TodaySummaryDto>(`/dashboard/today/summary${qs}`),
    refetchInterval: 60_000,
  });
}

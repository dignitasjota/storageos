import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { TodayDto, TodaySummaryDto } from '@storageos/shared';

/** Bandeja operativa «Hoy»: lo que el equipo debe atender (sondea cada 60 s). */
export function useToday(facilityId?: string, mine = false) {
  const p = new URLSearchParams();
  if (facilityId) p.set('facilityId', facilityId);
  if (mine) p.set('mine', '1');
  const qs = p.toString() ? `?${p.toString()}` : '';
  return useQuery({
    queryKey: ['dashboard', 'today', facilityId ?? null, mine] as const,
    queryFn: () => apiFetch<TodayDto>(`/dashboard/today${qs}`),
    // Cada 5 minutos y al volver a la pestaña (no cada minuto todo el día).
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });
}

/** Cifras del mes y actividad de las últimas 48 h (cabecera de «Hoy»). */
export function useTodaySummary(facilityId?: string) {
  const qs = facilityId ? `?facilityId=${facilityId}` : '';
  return useQuery({
    queryKey: ['dashboard', 'today', 'summary', facilityId ?? null] as const,
    queryFn: () => apiFetch<TodaySummaryDto>(`/dashboard/today/summary${qs}`),
    // Cada 5 minutos y al volver a la pestaña (no cada minuto todo el día).
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });
}

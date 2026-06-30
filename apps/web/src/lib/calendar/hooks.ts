import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { CalendarEventsDto } from '@storageos/shared';

/** Eventos del calendario operativo en un rango [from, to] (YYYY-MM-DD). */
export function useCalendar(from: string, to: string) {
  return useQuery({
    queryKey: ['calendar', from, to] as const,
    queryFn: () => apiFetch<CalendarEventsDto>(`/calendar?from=${from}&to=${to}`),
    enabled: Boolean(from && to),
  });
}

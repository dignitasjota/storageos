import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { useHeaderFacilityId } from '../facilities/store';

import type { CalendarEventsDto } from '@storageos/shared';

/** Eventos del calendario operativo en un rango [from, to] (YYYY-MM-DD). */
export function useCalendar(from: string, to: string) {
  const facilityId = useHeaderFacilityId();
  return useQuery({
    queryKey: ['calendar', from, to, facilityId ?? 'all'] as const,
    queryFn: () =>
      apiFetch<CalendarEventsDto>(
        `/calendar?from=${from}&to=${to}${facilityId ? `&facilityId=${facilityId}` : ''}`,
      ),
    enabled: Boolean(from && to),
  });
}

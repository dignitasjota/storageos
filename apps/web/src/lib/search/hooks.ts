import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { SearchResultsDto } from '@storageos/shared';

/** Búsqueda global del panel (inquilinos, contratos, trasteros, facturas). */
export function useGlobalSearch(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: ['search', query] as const,
    queryFn: () => apiFetch<SearchResultsDto>(`/search?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
  });
}

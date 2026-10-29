import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { apiFetch } from './auth/api';

import type { PageDto } from '@storageos/shared';

/**
 * Lista paginada por cursor (`GET <path>/page`): carga 50 filas y «Cargar más»
 * pide las siguientes. La clave empieza por `root`, así que las mutaciones que
 * ya invalidan `[root]` la refrescan sin cambios.
 */
export function usePagedList<T>(
  root: string,
  path: string,
  params: Record<string, string | undefined> = {},
  options: { enabled?: boolean; refetchInterval?: number } = {},
) {
  const query = useInfiniteQuery({
    queryKey: [root, 'page', params] as const,
    enabled: options.enabled ?? true,
    ...(options.refetchInterval
      ? { refetchInterval: options.refetchInterval, refetchIntervalInBackground: false }
      : {}),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
      if (pageParam) qs.set('cursor', pageParam);
      return apiFetch<PageDto<T>>(`${path}/page?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Mientras llega la búsqueda nueva, se siguen viendo los resultados anteriores.
    placeholderData: (prev) => prev,
  });
  return {
    ...query,
    rows: query.data?.pages.flatMap((p) => p.items) ?? [],
    loadMore: {
      hasMore: !!query.hasNextPage,
      loading: query.isFetchingNextPage,
      onLoadMore: () => void query.fetchNextPage(),
    },
  };
}

/** Texto de búsqueda con espera (no lanza una petición por cada tecla). */
export function useDebouncedSearch(delay = 300): [string, string, (v: string) => void] {
  const [value, setValue] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value.trim()), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return [value, debounced, setValue];
}

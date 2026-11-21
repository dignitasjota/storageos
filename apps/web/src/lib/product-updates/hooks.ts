import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { getImpersonation } from '../auth/impersonation';

import type { PageDto, ProductUpdateDto } from '@storageos/shared';

/** Página de novedades: lo publicado después de `readUntil` estaba sin leer. */
export type ProductUpdatesPage = PageDto<ProductUpdateDto> & { readUntil: string };

/** «Novedades» de la plataforma (vista del tenant), por páginas con «Cargar más». */
export function useProductUpdatesPages() {
  const query = useInfiniteQuery({
    queryKey: ['product-updates', 'page'] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<ProductUpdatesPage>(
        `/product-updates/page${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  return {
    ...query,
    rows: query.data?.pages.flatMap((p) => p.items) ?? [],
  };
}

/** La novedad destacada reciente y sin leer que se enseña al entrar (o null). */
export function useHighlightedProductUpdate(enabled = true) {
  return useQuery({
    queryKey: ['product-updates', 'highlighted'] as const,
    queryFn: async () =>
      (await apiFetch<{ update: ProductUpdateDto | null }>('/product-updates/highlighted')).update,
    enabled,
  });
}

/** Nº de novedades sin ver — para el aviso del menú (sondea cada 5 min). */
export function useProductUpdatesUnread() {
  return useQuery({
    queryKey: ['product-updates', 'unread'] as const,
    queryFn: () => apiFetch<{ count: number }>('/product-updates/unread-count'),
    refetchInterval: 5 * 60_000,
  });
}

/**
 * Marca las novedades como vistas. En una sesión de soporte (impersonación) no
 * se envía nada: la marca de leído es de la persona suplantada.
 */
export function useMarkProductUpdatesSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (getImpersonation()) return false;
      await apiFetch<void>('/product-updates/seen', { method: 'POST' });
      return true;
    },
    onSuccess: (marked) => {
      if (!marked) return;
      qc.setQueryData(['product-updates', 'unread'], { count: 0 });
      qc.setQueryData(['product-updates', 'highlighted'], null);
    },
  });
}

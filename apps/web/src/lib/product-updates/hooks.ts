import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { getImpersonation } from '../auth/impersonation';

import type {
  PageDto,
  ProductUpdateCategory,
  ProductUpdateDto,
  ProductUpdateReaction,
  SelfAddonTrialResultDto,
} from '@storageos/shared';

/** Página de novedades: lo publicado después de `readUntil` estaba sin leer. */
export type ProductUpdatesPage = PageDto<ProductUpdateDto> & { readUntil: string };

/** Filtros de la página de Novedades. */
export interface ProductUpdatesFilters {
  category?: ProductUpdateCategory | null;
  search?: string;
  onlyMyPlan?: boolean;
}

/** «Novedades» de la plataforma (vista del tenant), por páginas con «Cargar más». */
export function useProductUpdatesPages(filters: ProductUpdatesFilters = {}) {
  const category = filters.category ?? null;
  const search = filters.search?.trim() ?? '';
  const onlyMyPlan = !!filters.onlyMyPlan;
  const query = useInfiniteQuery({
    queryKey: ['product-updates', 'page', { category, search, onlyMyPlan }] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (pageParam) qs.set('cursor', pageParam);
      if (category) qs.set('category', category);
      if (search) qs.set('search', search);
      if (onlyMyPlan) qs.set('onlyMyPlan', '1');
      const q = qs.toString();
      return apiFetch<ProductUpdatesPage>(`/product-updates/page${q ? `?${q}` : ''}`);
    },
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

/** «¿Te ha sido útil?»: 👍, 👎 o quitarla (null). */
export function useSetProductUpdateReaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; value: ProductUpdateReaction | null }) =>
      apiFetch<{ value: ProductUpdateReaction | null }>(`/product-updates/${args.id}/reaction`, {
        method: 'PUT',
        json: { value: args.value },
      }),
    onSuccess: (res, args) => {
      // Se actualiza en las páginas ya cargadas sin volver a pedirlas.
      qc.setQueriesData<{ pages: ProductUpdatesPage[]; pageParams: unknown[] }>(
        { queryKey: ['product-updates', 'page'] },
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              items: p.items.map((u) => (u.id === args.id ? { ...u, myReaction: res.value } : u)),
            })),
          },
      );
    },
  });
}

/** Prueba gratis de un extra activada desde una novedad (quien gestiona la suscripción). */
export function useStartAddonTrialFromUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (addonId: string) =>
      apiFetch<SelfAddonTrialResultDto>(`/settings/saas-billing/addons/${addonId}/trial`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['product-updates'] });
      // Cambian las funciones del negocio (menú, páginas, `/auth/me`).
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
      void qc.invalidateQueries({ queryKey: ['saas-billing'] });
    },
  });
}

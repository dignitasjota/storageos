import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { ProductUpdateDto } from '@storageos/shared';

/** «Novedades» de la plataforma (vista del tenant). */
export function useProductUpdates() {
  return useQuery({
    queryKey: ['product-updates'] as const,
    queryFn: () => apiFetch<ProductUpdateDto[]>('/product-updates'),
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

export function useMarkProductUpdatesSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/product-updates/seen', { method: 'POST' }),
    onSuccess: () => qc.setQueryData(['product-updates', 'unread'], { count: 0 }),
  });
}

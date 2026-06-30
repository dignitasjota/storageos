import { useInfiniteQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { AuditLogListDto } from '@storageos/shared';

/** Registro de actividad del tenant (paginado por cursor). */
export function useAuditLog() {
  return useInfiniteQuery({
    queryKey: ['audit-logs'] as const,
    queryFn: ({ pageParam }) =>
      apiFetch<AuditLogListDto>(`/audit-logs${pageParam ? `?cursor=${pageParam}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

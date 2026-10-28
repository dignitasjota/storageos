import { useInfiniteQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { AuditLogFilters, AuditLogListDto } from '@storageos/shared';

export function auditQuery(filters: AuditLogFilters, cursor?: string, limit?: number): string {
  const p = new URLSearchParams();
  if (cursor) p.set('cursor', cursor);
  if (filters.userId) p.set('userId', filters.userId);
  if (filters.action) p.set('action', filters.action);
  if (filters.from) p.set('from', filters.from);
  if (filters.to) p.set('to', filters.to);
  if (limit) p.set('limit', String(limit));
  const qs = p.toString();
  return `/audit-logs${qs ? `?${qs}` : ''}`;
}

/** Registro de actividad del tenant (paginado por cursor, con filtros). */
export function useAuditLog(filters: AuditLogFilters = {}) {
  return useInfiniteQuery({
    queryKey: ['audit-logs', filters] as const,
    queryFn: ({ pageParam }) =>
      apiFetch<AuditLogListDto>(auditQuery(filters, pageParam || undefined)),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

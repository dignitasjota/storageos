import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { ReportGeneratorCatalogEntry, ReportRunDto, RunReportInput } from '@storageos/shared';

export const reportsCatalogKey = ['reports', 'catalog'] as const;
export const reportsListKey = ['reports'] as const;
export const reportKey = (id: string) => ['reports', id] as const;

export function useReportCatalog() {
  return useQuery({
    queryKey: reportsCatalogKey,
    queryFn: () => apiFetch<ReportGeneratorCatalogEntry[]>('/reports/catalog'),
    staleTime: 5 * 60_000,
  });
}

export function useReports() {
  return useQuery({
    queryKey: reportsListKey,
    queryFn: () => apiFetch<ReportRunDto[]>('/reports'),
    // Si hay reports en pending/running, refresca cada 2s para verlos terminar.
    refetchInterval: (query) => {
      const data = query.state.data as ReportRunDto[] | undefined;
      if (!data) return false;
      const hasActive = data.some((r) => r.status === 'pending' || r.status === 'running');
      return hasActive ? 2000 : false;
    },
  });
}

export function useReport(id: string | undefined) {
  return useQuery({
    queryKey: id ? reportKey(id) : ['reports', 'none'],
    queryFn: () => apiFetch<ReportRunDto>(`/reports/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data as ReportRunDto | undefined;
      if (!data) return false;
      return data.status === 'pending' || data.status === 'running' ? 2000 : false;
    },
  });
}

export function useRunReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RunReportInput) =>
      apiFetch<ReportRunDto>('/reports/run', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reportsListKey });
    },
  });
}

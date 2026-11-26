'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SistrixScope } from './sistrix-hooks';
import type {
  SeoAlertSettings,
  SeoAlertStatus,
  SeoAlertType,
  SeoConversionsDto,
  SeoPanelPeriod,
  SeoProjectAlertDto,
  SeoProjectAlertListDto,
  SeoReportContentDto,
  SeoReportDto,
  SeoReportKind,
  SeoReportSettings,
  SeoReportsDto,
  UpdateSeoAlertSettingsInput,
  UpdateSeoReportSettingsInput,
} from '@storageos/shared';

import { adminApiFetch } from '@/lib/admin/api';
import { apiFetch } from '@/lib/auth/api';

/**
 * Lo que trae Google, alertas e informes de un proyecto SEO, desde el panel
 * admin (cualquier proyecto; los de un tenant, en lectura) o desde el del
 * tenant. El mismo «ámbito» que SISTRIX y el plan.
 */
export type ReportScope = SistrixScope;

type Fetcher = <T>(path: string, options?: { method?: string; json?: unknown }) => Promise<T>;

function scopeApi(scope: ReportScope) {
  const fetcher: Fetcher = scope.kind === 'admin' ? adminApiFetch : apiFetch;
  const base = scope.kind === 'admin' ? `/admin/seo/projects/${scope.projectId}` : '/seo-advanced';
  const key =
    scope.kind === 'admin'
      ? ['admin', 'seo', 'reports', scope.projectId]
      : ['seo-advanced', 'reports'];
  return { fetcher, base, key };
}

const qs = (params: Record<string, string | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  return p.toString();
};

function useInvalidate(scope: ReportScope) {
  const qc = useQueryClient();
  const { key } = scopeApi(scope);
  return () => qc.invalidateQueries({ queryKey: key });
}

// ------------------------------------------------------------ conversiones

export function useSeoConversions(scope: ReportScope, period: SeoPanelPeriod) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'conversions', period],
    queryFn: () => fetcher<SeoConversionsDto>(`${base}/conversions?${qs({ period })}`),
  });
}

export function useRecalcConversions(scope: ReportScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: () => fetcher(`${base}/conversions/recalc`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

/** Solo en el admin: el proyecto de la plataforma cuenta (o no) lo de trasteros.pro. */
export function useSetPlatformConversions(scope: ReportScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (platformConversions: boolean | null) =>
      fetcher(`${base}/conversions/settings`, { method: 'PUT', json: { platformConversions } }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------- alertas

export interface AlertFilters {
  status: SeoAlertStatus | 'live' | null;
  type: SeoAlertType | null;
}

export function useSeoAlerts(scope: ReportScope, filters: AlertFilters) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'alerts', filters],
    queryFn: () =>
      fetcher<SeoProjectAlertListDto>(
        `${base}/alerts?${qs({ status: filters.status, type: filters.type })}`,
      ),
  });
}

export function useAlertAction(scope: ReportScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (args: {
      id: string;
      action: 'silence' | 'unsilence' | 'resolve';
      days?: number;
    }) =>
      fetcher<SeoProjectAlertDto>(`${base}/alerts/${args.id}/${args.action}`, {
        method: 'POST',
        json: args.action === 'silence' ? { ...(args.days ? { days: args.days } : {}) } : {},
      }),
    onSuccess: invalidate,
  });
}

export function useCheckAlerts(scope: ReportScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: () =>
      fetcher<{ created: number; resolved: number; open: number }>(`${base}/alerts/check`, {
        method: 'POST',
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateAlertSettings(scope: ReportScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: UpdateSeoAlertSettingsInput) =>
      fetcher<SeoAlertSettings>(`${base}/alerts/settings`, { method: 'PUT', json: input }),
    onSuccess: invalidate,
  });
}

// --------------------------------------------------------------- informes

export function useSeoReports(scope: ReportScope) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'reports'],
    queryFn: () => fetcher<SeoReportsDto>(`${base}/reports`),
  });
}

export function useSeoReportPreview(scope: ReportScope, kind: SeoReportKind | null) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'preview', kind],
    queryFn: () => fetcher<SeoReportContentDto>(`${base}/reports/preview?${qs({ kind })}`),
    enabled: !!kind,
  });
}

export function useUpdateReportSettings(scope: ReportScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: UpdateSeoReportSettingsInput) =>
      fetcher<SeoReportSettings>(`${base}/reports/settings`, { method: 'PUT', json: input }),
    onSuccess: invalidate,
  });
}

export function useSendReport(scope: ReportScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (kind: SeoReportKind) =>
      fetcher<SeoReportDto>(`${base}/reports/send`, { method: 'POST', json: { kind } }),
    onSuccess: invalidate,
  });
}

/** Abre el PDF de un informe (URL firmada de unos minutos). */
export async function openReportPdf(scope: ReportScope, reportId: string): Promise<void> {
  const { fetcher, base } = scopeApi(scope);
  const { url } = await fetcher<{ url: string }>(`${base}/reports/${reportId}/pdf`);
  window.open(url, '_blank', 'noopener');
}

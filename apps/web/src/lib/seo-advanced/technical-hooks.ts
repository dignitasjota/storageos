'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SistrixScope } from './sistrix-hooks';
import type {
  RunSeoPageSpeedInput,
  SeoCrawlInternalLinksDto,
  SeoCrawlIssueDto,
  SeoCrawlIssueListDto,
  SeoCrawlOverviewDto,
  SeoCrawlPageDetailDto,
  SeoCrawlPageListDto,
  SeoCrawlSettings,
  SeoCrawlStartResultDto,
  UpdateSeoCrawlSettingsInput,
  UpdateSeoDiagnosticInput,
  SeoInspectResultDto,
  SeoInspectionHistoryDto,
  SeoInspectionsDto,
  SeoPageSpeedDto,
  SeoPageSpeedHistoryDto,
  SeoPageSpeedRunDto,
  SeoPageSpeedStrategy,
  SeoTechnicalSettings,
  UpdateSeoTechnicalSettingsInput,
} from '@storageos/shared';

import { adminApiFetch, adminApiFetchBlob } from '@/lib/admin/api';
import { apiFetch, apiFetchBlob } from '@/lib/auth/api';

/**
 * Inspección de URL de Google y PageSpeed de un proyecto SEO (PR 9), desde el
 * panel admin (cualquier proyecto; los de un tenant, en lectura) o desde el
 * del tenant. El mismo «ámbito» que SISTRIX, el plan y los informes.
 */
export type TechnicalScope = SistrixScope;

type Fetcher = <T>(path: string, options?: { method?: string; json?: unknown }) => Promise<T>;

function scopeApi(scope: TechnicalScope) {
  const fetcher: Fetcher = scope.kind === 'admin' ? adminApiFetch : apiFetch;
  const base = scope.kind === 'admin' ? `/admin/seo/projects/${scope.projectId}` : '/seo-advanced';
  const root = scope.kind === 'admin' ? ['admin', 'seo'] : ['seo-advanced'];
  const id = scope.kind === 'admin' ? [scope.projectId] : [];
  const key = [...root, 'technical', ...id];
  /** Lo que cambia tras inspeccionar: indexación, palabras, oportunidades y alertas. */
  const related = [
    [...root, 'diagnostics', ...id],
    [...root, 'opportunities', ...id],
    [...root, 'reports', ...id],
  ];
  return { fetcher, base, key, related };
}

function useInvalidate(scope: TechnicalScope, withRelated = false) {
  const qc = useQueryClient();
  const { key, related } = scopeApi(scope);
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key }),
      ...(withRelated ? related.map((k) => qc.invalidateQueries({ queryKey: k })) : []),
    ]);
}

// --------------------------------------------------------------- inspección

export function useSeoInspections(scope: TechnicalScope, enabled = true) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'inspections'],
    queryFn: () => fetcher<SeoInspectionsDto>(`${base}/inspections`),
    enabled,
    // Mientras haya algo en la cola, se refresca solo.
    refetchInterval: (q) => ((q.state.data?.quota.queued ?? 0) > 0 ? 5000 : false),
  });
}

export function useInspectionHistory(scope: TechnicalScope, url: string | null) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'inspection-history', url],
    queryFn: () =>
      fetcher<SeoInspectionHistoryDto>(
        `${base}/inspections/history?url=${encodeURIComponent(url ?? '')}`,
      ),
    enabled: !!url,
  });
}

export function useInspectUrl(scope: TechnicalScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope, true);
  return useMutation({
    mutationFn: (url: string) =>
      fetcher<SeoInspectResultDto>(`${base}/inspections`, { method: 'POST', json: { url } }),
    onSuccess: invalidate,
  });
}

export function useInspectionBatch(scope: TechnicalScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: () => fetcher<{ queued: number }>(`${base}/inspections/batch`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useUpdateTechnicalSettings(scope: TechnicalScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: UpdateSeoTechnicalSettingsInput) =>
      fetcher<SeoTechnicalSettings>(`${base}/technical/settings`, { method: 'PUT', json: input }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------- PageSpeed

export function useSeoPageSpeed(scope: TechnicalScope) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'pagespeed'],
    queryFn: () => fetcher<SeoPageSpeedDto>(`${base}/pagespeed`),
    // PageSpeed tarda 10-30 segundos por medición: se refresca mientras haya pendientes.
    refetchInterval: (q) => ((q.state.data?.pending ?? 0) > 0 ? 8000 : false),
  });
}

export function usePageSpeedHistory(
  scope: TechnicalScope,
  url: string | null,
  strategy: SeoPageSpeedStrategy,
) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'pagespeed-history', url, strategy],
    queryFn: () =>
      fetcher<SeoPageSpeedHistoryDto>(
        `${base}/pagespeed/history?url=${encodeURIComponent(url ?? '')}&strategy=${strategy}`,
      ),
    enabled: !!url,
  });
}

export function useRunPageSpeed(scope: TechnicalScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: RunSeoPageSpeedInput) =>
      fetcher<SeoPageSpeedRunDto[]>(`${base}/pagespeed`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

// ----------------------------------------------------------------- rastreo

/** Filtros de la lista de incidencias del rastreo. */
export interface CrawlIssueFilters {
  severity: string;
  group: string;
  view: 'open' | 'resolved' | 'all';
  onlyNew: boolean;
  search: string;
}

/** Filtros de la lista de páginas del rastreo. */
export interface CrawlPageFilters {
  filter: 'all' | 'errors' | 'redirects' | 'noindex' | 'blocked' | 'orphans' | 'issues';
  search: string;
}

const qs = (params: Record<string, string | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== false) p.set(k, String(v));
  }
  return p.toString();
};

const issueQs = (f: CrawlIssueFilters) =>
  qs({
    severity: f.severity,
    group: f.group,
    view: f.view,
    onlyNew: f.onlyNew,
    search: f.search.trim(),
  });

/** El rastreo del proyecto: el último, el que está en marcha y el historial. */
export function useSeoCrawl(scope: TechnicalScope) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'crawl'],
    queryFn: () => fetcher<SeoCrawlOverviewDto>(`${base}/crawl`),
    // Mientras haya un rastreo en marcha, se refresca solo.
    refetchInterval: (q) => (q.state.data?.live ? 4000 : false),
  });
}

/** Lo que cambia al terminar un rastreo: incidencias, páginas, indexación, oportunidades y alertas. */
function useInvalidateCrawl(scope: TechnicalScope) {
  return useInvalidate(scope, true);
}

export function useStartCrawl(scope: TechnicalScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidateCrawl(scope);
  return useMutation({
    mutationFn: () => fetcher<SeoCrawlStartResultDto>(`${base}/crawl`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useCancelCrawl(scope: TechnicalScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidateCrawl(scope);
  return useMutation({
    mutationFn: (crawlId: string) =>
      fetcher<void>(`${base}/crawl/${crawlId}/cancel`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useUpdateCrawlSettings(scope: TechnicalScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: UpdateSeoCrawlSettingsInput) =>
      fetcher<SeoCrawlSettings>(`${base}/crawl/settings`, { method: 'PUT', json: input }),
    onSuccess: invalidate,
  });
}

export function useCrawlIssues(scope: TechnicalScope, filters: CrawlIssueFilters, enabled = true) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'crawl-issues', filters],
    queryFn: () => fetcher<SeoCrawlIssueListDto>(`${base}/crawl/issues?${issueQs(filters)}`),
    enabled,
  });
}

export function useUpdateCrawlIssue(scope: TechnicalScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSeoDiagnosticInput }) =>
      fetcher<SeoCrawlIssueDto>(`${base}/crawl/issues/${id}`, { method: 'PATCH', json: input }),
    onSuccess: invalidate,
  });
}

export function useCrawlPages(scope: TechnicalScope, filters: CrawlPageFilters, enabled = true) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'crawl-pages', filters],
    queryFn: () =>
      fetcher<SeoCrawlPageListDto>(
        `${base}/crawl/pages?${qs({ filter: filters.filter, search: filters.search.trim() })}`,
      ),
    enabled,
  });
}

export function useCrawlPage(scope: TechnicalScope, url: string | null) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'crawl-page', url],
    queryFn: () =>
      fetcher<SeoCrawlPageDetailDto>(`${base}/crawl/page?url=${encodeURIComponent(url ?? '')}`),
    enabled: !!url,
    retry: false,
  });
}

export function useCrawlInternalLinks(scope: TechnicalScope, enabled = true) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'crawl-internal-links'],
    queryFn: () => fetcher<SeoCrawlInternalLinksDto>(`${base}/crawl/internal-links`),
    enabled,
  });
}

/** Descarga el CSV de las incidencias con los filtros puestos. */
export async function downloadCrawlIssuesCsv(
  scope: TechnicalScope,
  filters: CrawlIssueFilters,
): Promise<void> {
  const { base } = scopeApi(scope);
  const blob = scope.kind === 'admin' ? adminApiFetchBlob : apiFetchBlob;
  const file = await blob(`${base}/crawl/issues/csv?${issueQs(filters)}`);
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rastreo-incidencias.csv';
  a.click();
  URL.revokeObjectURL(url);
}

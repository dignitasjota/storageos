'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SistrixScope } from './sistrix-hooks';
import type {
  SeoCannibalizationDto,
  SeoCannibalizationSummaryDto,
  SeoDiagnosticListDto,
  SeoDiagnosticSettingsDto,
  SeoDiagnosticStatus,
  SeoDiagnosticsRecalcDto,
  SeoIndexFindingDto,
  SeoIndexSummaryDto,
  SeoKeywordCandidatesDto,
  SeoKeywordImportPreviewDto,
  SeoKeywordImportRequest,
  SeoKeywordImportResultDto,
  SeoSitemapsDto,
  SeoTrackedKeywordDetailDto,
  SeoTrackedKeywordsDto,
  UpdateSeoDiagnosticInput,
  UpdateSeoDiagnosticSettingsInput,
} from '@storageos/shared';

import { adminApiFetch, adminApiFetchBlob } from '@/lib/admin/api';
import { apiFetch, apiFetchBlob } from '@/lib/auth/api';

/**
 * Diagnóstico de un proyecto (palabras seguidas, canibalización e
 * indexación), desde el panel admin (cualquier proyecto; los de un tenant,
 * en lectura) o desde el del tenant. El mismo «ámbito» que SISTRIX.
 */
export type DiagnosticScope = SistrixScope;

type Fetcher = <T>(path: string, options?: { method?: string; json?: unknown }) => Promise<T>;

function scopeApi(scope: DiagnosticScope) {
  const fetcher: Fetcher = scope.kind === 'admin' ? adminApiFetch : apiFetch;
  const blob = scope.kind === 'admin' ? adminApiFetchBlob : apiFetchBlob;
  const base =
    scope.kind === 'admin'
      ? `/admin/seo/projects/${scope.projectId}/diagnostics`
      : '/seo-advanced/diagnostics';
  const key =
    scope.kind === 'admin'
      ? ['admin', 'seo', 'diagnostics', scope.projectId]
      : ['seo-advanced', 'diagnostics'];
  // Las palabras se dan de alta por las rutas de palabras del proyecto (PR 3).
  const sistrixKey =
    scope.kind === 'admin'
      ? ['admin', 'seo', 'sistrix', scope.projectId]
      : ['seo-advanced', 'sistrix'];
  return { fetcher, blob, base, key, sistrixKey };
}

const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  }
  return p.toString();
};

export function useTrackedKeywords(
  scope: DiagnosticScope,
  params: { days: number; domainId: string | null },
) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'tracked', params],
    queryFn: () =>
      fetcher<SeoTrackedKeywordsDto>(
        `${base}/tracked-keywords?${qs({ days: params.days, domainId: params.domainId })}`,
      ),
  });
}

export function useTrackedKeywordDetail(
  scope: DiagnosticScope,
  id: string | null,
  params: { days: number; domainId: string | null },
) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'tracked-detail', id, params],
    queryFn: () =>
      fetcher<SeoTrackedKeywordDetailDto>(
        `${base}/tracked-keywords/${id}?${qs({ days: params.days, domainId: params.domainId })}`,
      ),
    enabled: !!id,
  });
}

export interface CandidateFilters {
  days: number;
  domainId: string | null;
  minImpressions: number;
  maxPosition: number | null;
  excludeBrand: boolean;
  excludeTracked: boolean;
  search: string;
}

export function useKeywordCandidates(
  scope: DiagnosticScope,
  filters: CandidateFilters,
  enabled: boolean,
) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'candidates', filters],
    queryFn: () =>
      fetcher<SeoKeywordCandidatesDto>(
        `${base}/keyword-candidates?${qs({
          days: filters.days,
          domainId: filters.domainId,
          minImpressions: filters.minImpressions,
          maxPosition: filters.maxPosition,
          excludeBrand: filters.excludeBrand ? '1' : '0',
          excludeTracked: filters.excludeTracked ? '1' : '0',
          search: filters.search.trim(),
        })}`,
      ),
    enabled,
  });
}

/** Tras tocar las palabras, se ponen al día el diagnóstico y la parte de SISTRIX. */
function useInvalidate(scope: DiagnosticScope) {
  const qc = useQueryClient();
  const { key, sistrixKey } = scopeApi(scope);
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key }),
      qc.invalidateQueries({ queryKey: sistrixKey }),
    ]);
}

export function useKeywordImportPreview(scope: DiagnosticScope) {
  const { fetcher, base } = scopeApi(scope);
  return useMutation({
    mutationFn: (input: SeoKeywordImportRequest) =>
      fetcher<SeoKeywordImportPreviewDto>(`${base}/keyword-import/preview`, {
        method: 'POST',
        json: input,
      }),
  });
}

export function useKeywordImportCommit(scope: DiagnosticScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: SeoKeywordImportRequest) =>
      fetcher<SeoKeywordImportResultDto>(`${base}/keyword-import`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

export function useDiagnosticSettings(scope: DiagnosticScope, enabled = true) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'settings'],
    queryFn: () => fetcher<SeoDiagnosticSettingsDto>(`${base}/settings`),
    enabled,
  });
}

export function useUpdateDiagnosticSettings(scope: DiagnosticScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: UpdateSeoDiagnosticSettingsInput) =>
      fetcher<SeoDiagnosticSettingsDto>(`${base}/settings`, { method: 'PUT', json: input }),
    onSuccess: invalidate,
  });
}

export function useRecalculateDiagnostics(scope: DiagnosticScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: () => fetcher<SeoDiagnosticsRecalcDto>(`${base}/recalculate`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export interface DiagnosticListFilters {
  statuses: SeoDiagnosticStatus[];
  severity?: string | null;
  category?: string | null;
  search: string;
}

const listQs = (f: DiagnosticListFilters) =>
  qs({
    status: f.statuses.join(','),
    severity: f.severity,
    category: f.category,
    search: f.search.trim(),
  });

export function useCannibalizationSummary(scope: DiagnosticScope) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'cannibalization-summary'],
    queryFn: () => fetcher<SeoCannibalizationSummaryDto>(`${base}/cannibalization/summary`),
  });
}

export function useCannibalizations(scope: DiagnosticScope, filters: DiagnosticListFilters) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'cannibalization', filters],
    queryFn: () =>
      fetcher<SeoDiagnosticListDto<SeoCannibalizationDto>>(
        `${base}/cannibalization?${listQs(filters)}`,
      ),
  });
}

export function useIndexSummary(scope: DiagnosticScope) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'index-summary'],
    queryFn: () => fetcher<SeoIndexSummaryDto>(`${base}/index-findings/summary`),
  });
}

export function useIndexFindings(scope: DiagnosticScope, filters: DiagnosticListFilters) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'index', filters],
    queryFn: () =>
      fetcher<SeoDiagnosticListDto<SeoIndexFindingDto>>(
        `${base}/index-findings?${listQs(filters)}`,
      ),
  });
}

export function useSitemaps(scope: DiagnosticScope, enabled: boolean) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'sitemaps'],
    queryFn: () => fetcher<SeoSitemapsDto>(`${base}/index-findings/sitemaps`),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useUpdateDiagnostic(scope: DiagnosticScope, kind: 'cannibalization' | 'index') {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  const path = kind === 'cannibalization' ? 'cannibalization' : 'index-findings';
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSeoDiagnosticInput }) =>
      fetcher<SeoCannibalizationDto | SeoIndexFindingDto>(`${base}/${path}/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

/** Descarga un CSV del diagnóstico. */
export async function downloadDiagnosticCsv(
  scope: DiagnosticScope,
  what: 'tracked-keywords' | 'cannibalization' | 'index-findings',
  params: Record<string, string | number | null | undefined>,
  fileName: string,
): Promise<void> {
  const { blob, base } = scopeApi(scope);
  const file = await blob(`${base}/${what}/csv?${qs(params)}`);
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

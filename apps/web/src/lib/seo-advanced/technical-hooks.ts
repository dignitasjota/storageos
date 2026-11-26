'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SistrixScope } from './sistrix-hooks';
import type {
  RunSeoPageSpeedInput,
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

import { adminApiFetch } from '@/lib/admin/api';
import { apiFetch } from '@/lib/auth/api';

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

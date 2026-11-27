'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SistrixScope } from './sistrix-hooks';
import type {
  BatchUpdateSeoKeywordsInput,
  ProbeSistrixApiInput,
  SeoAnnotationProposalsDto,
  SeoApiProbeResultDto,
  SeoApiSampleDto,
  SeoAreasDto,
  SeoBatchResultDto,
  SeoBrandSplitDto,
  SeoCompetitionEvolutionDto,
  SeoCompetitionGroupsDto,
  SeoCompetitionMoversDto,
  SeoOpportunityYearAgoDto,
  SeoPageDevicesDto,
  SeoSiteChangeDto,
  SeoSistrixCsvKind,
  SeoSistrixCsvPreviewDto,
  SeoSistrixImportDto,
  SeoSistrixRequestsPageDto,
} from '@storageos/shared';

import { adminApiFetch } from '@/lib/admin/api';
import { apiFetch } from '@/lib/auth/api';

/**
 * Mejoras de SEO Avanzado (marca, zonas, móvil, competencia, anotaciones, CSV de
 * SISTRIX, palabras en lote y año anterior). El mismo «ámbito» que el resto:
 * el panel admin (cualquier proyecto) o el del tenant (el suyo).
 */
export type ImprovementScope = SistrixScope;

interface Opts {
  method?: string;
  json?: unknown;
  formData?: FormData;
}
type Fetcher = <T>(path: string, options?: Opts) => Promise<T>;

function scopeApi(scope: ImprovementScope) {
  const fetcher = (scope.kind === 'admin' ? adminApiFetch : apiFetch) as unknown as Fetcher;
  const base = scope.kind === 'admin' ? `/admin/seo/projects/${scope.projectId}` : '/seo-advanced';
  const root =
    scope.kind === 'admin' ? ['admin', 'seo', 'imp', scope.projectId] : ['seo-advanced', 'imp'];
  return { fetcher, base, root };
}

const qs = (params: Record<string, string | null | undefined | boolean>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, String(v));
  return p.toString();
};

// ----------------------------------------------------- marca y móvil

export interface PeriodParams {
  period: string;
  from?: string | undefined;
  to?: string | undefined;
  domainId?: string | null | undefined;
}

export function useBrandSplit(scope: ImprovementScope, p: PeriodParams, enabled = true) {
  const { fetcher, base, root } = scopeApi(scope);
  return useQuery({
    queryKey: [...root, 'brand', p],
    enabled,
    queryFn: () =>
      fetcher<SeoBrandSplitDto>(
        `${base}/brand?${qs({ period: p.period, from: p.from, to: p.to, domainId: p.domainId })}`,
      ),
  });
}

export function usePageDevices(
  scope: ImprovementScope,
  p: PeriodParams & { onlyWorse: boolean },
  enabled = true,
) {
  const { fetcher, base, root } = scopeApi(scope);
  return useQuery({
    queryKey: [...root, 'devices', p],
    enabled,
    queryFn: () =>
      fetcher<SeoPageDevicesDto>(
        `${base}/pages/devices?${qs({
          period: p.period,
          from: p.from,
          to: p.to,
          domainId: p.domainId,
          onlyWorse: p.onlyWorse,
        })}`,
      ),
  });
}

// ------------------------------------------------------------ zonas

export function useSeoAreas(scope: ImprovementScope, enabled = true) {
  const { fetcher, base, root } = scopeApi(scope);
  return useQuery({
    queryKey: [...root, 'areas'],
    enabled,
    queryFn: () => fetcher<SeoAreasDto>(`${base}/areas`),
  });
}

export function useSetSeoAreas(scope: ImprovementScope) {
  const qc = useQueryClient();
  const { fetcher, base, root } = scopeApi(scope);
  return useMutation({
    mutationFn: (areas: string[]) =>
      fetcher<SeoAreasDto>(`${base}/areas`, { method: 'PUT', json: { areas } }),
    onSuccess: (data) => {
      qc.setQueryData([...root, 'areas'], data);
      void qc.invalidateQueries({ queryKey: [...root, 'brand'] });
    },
  });
}

// ------------------------------------------------------ competencia

export function useCompetitionMovers(scope: ImprovementScope, enabled = true) {
  const { fetcher, base, root } = scopeApi(scope);
  return useQuery({
    queryKey: [...root, 'movers'],
    enabled,
    queryFn: () => fetcher<SeoCompetitionMoversDto>(`${base}/competition/movers`),
  });
}

export function useCompetitionGroups(scope: ImprovementScope, enabled = true) {
  const { fetcher, base, root } = scopeApi(scope);
  return useQuery({
    queryKey: [...root, 'groups'],
    enabled,
    queryFn: () => fetcher<SeoCompetitionGroupsDto>(`${base}/competition/groups`),
  });
}

export function useCompetitionEvolution(
  scope: ImprovementScope,
  domain: string | null,
  keywordId: string | null,
) {
  const { fetcher, base, root } = scopeApi(scope);
  return useQuery({
    queryKey: [...root, 'evolution', domain, keywordId],
    enabled: !!domain && !!keywordId,
    queryFn: () =>
      fetcher<SeoCompetitionEvolutionDto>(
        `${base}/competition/evolution?${qs({ domain, keywordId })}`,
      ),
  });
}

// ----------------------------------------------------- anotaciones

export function useAnnotationProposals(scope: ImprovementScope, enabled = true) {
  const { fetcher, base, root } = scopeApi(scope);
  return useQuery({
    queryKey: [...root, 'annotations'],
    enabled,
    queryFn: () => fetcher<SeoAnnotationProposalsDto>(`${base}/annotations/proposals`),
  });
}

export function useAnnotationActions(scope: ImprovementScope) {
  const qc = useQueryClient();
  const { fetcher, base, root } = scopeApi(scope);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [...root, 'annotations'] });
    // Las actuaciones del plan (y sus marcas) también cambian.
    void qc.invalidateQueries({ queryKey: [scope.kind === 'admin' ? 'admin' : 'seo-advanced'] });
  };
  const confirm = useMutation({
    mutationFn: (sourceRef: string) =>
      fetcher<SeoSiteChangeDto>(`${base}/annotations/proposals/confirm`, {
        method: 'POST',
        json: { sourceRef },
      }),
    onSuccess: refresh,
  });
  const dismiss = useMutation({
    mutationFn: (sourceRefs: string[]) =>
      fetcher<void>(`${base}/annotations/proposals/dismiss`, {
        method: 'POST',
        json: { sourceRefs },
      }),
    onSuccess: refresh,
  });
  return { confirm, dismiss };
}

// ---------------------------------------------- CSV de SISTRIX

export function useSistrixImports(scope: ImprovementScope, enabled = true) {
  const { fetcher, base, root } = scopeApi(scope);
  return useQuery({
    queryKey: [...root, 'csv-imports'],
    enabled,
    queryFn: () => fetcher<SeoSistrixImportDto[]>(`${base}/sistrix-imports`),
  });
}

export interface CsvInput {
  kind: SeoSistrixCsvKind;
  file: File;
  domain?: string;
  keyword?: string;
}

const csvForm = (i: CsvInput) => {
  const f = new FormData();
  f.append('kind', i.kind);
  if (i.domain) f.append('domain', i.domain);
  if (i.keyword) f.append('keyword', i.keyword);
  f.append('file', i.file);
  return f;
};

export function useSistrixCsv(scope: ImprovementScope) {
  const qc = useQueryClient();
  const { fetcher, base, root } = scopeApi(scope);
  const preview = useMutation({
    mutationFn: (i: CsvInput) =>
      fetcher<SeoSistrixCsvPreviewDto>(`${base}/sistrix-imports/preview`, {
        method: 'POST',
        formData: csvForm(i),
      }),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [...root, 'csv-imports'] });
    void qc.invalidateQueries({ queryKey: [scope.kind === 'admin' ? 'admin' : 'seo-advanced'] });
  };
  const commit = useMutation({
    mutationFn: (i: CsvInput) =>
      fetcher<SeoSistrixImportDto>(`${base}/sistrix-imports`, {
        method: 'POST',
        formData: csvForm(i),
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      fetcher<void>(`${base}/sistrix-imports/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  return { preview, commit, remove };
}

// ------------------------------------------- palabras en lote

export function useKeywordBatch(scope: ImprovementScope) {
  const qc = useQueryClient();
  const { fetcher, base } = scopeApi(scope);
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: [scope.kind === 'admin' ? 'admin' : 'seo-advanced'] });
  const update = useMutation({
    mutationFn: (input: BatchUpdateSeoKeywordsInput) =>
      fetcher<SeoBatchResultDto>(`${base}/keywords-batch`, { method: 'PATCH', json: input }),
    onSuccess: refresh,
  });
  const acceptUrls = useMutation({
    mutationFn: () =>
      fetcher<SeoBatchResultDto>(`${base}/keywords-batch/accept-suggested-urls`, {
        method: 'POST',
        json: {},
      }),
    onSuccess: refresh,
  });
  const renameGroup = useMutation({
    mutationFn: (v: { from: string; to: string }) =>
      fetcher<SeoBatchResultDto>(`${base}/keyword-groups/rename`, { method: 'POST', json: v }),
    onSuccess: refresh,
  });
  return { update, acceptUrls, renameGroup };
}

// ------------------------------------------------- año anterior

export function useOpportunityYearAgo(
  scope: ImprovementScope,
  opportunityId: string | null,
  enabled = true,
) {
  const { fetcher, base, root } = scopeApi(scope);
  return useQuery({
    queryKey: [...root, 'year-ago', opportunityId],
    enabled: enabled && !!opportunityId,
    queryFn: () =>
      fetcher<SeoOpportunityYearAgoDto>(`${base}/opportunities/${opportunityId}/year-ago`),
  });
}

// --------------------------------- SISTRIX: transparencia / prueba

export function useTenantSistrixRequests(cursor: string | null, enabled = true) {
  return useQuery({
    queryKey: ['seo-advanced', 'imp', 'sistrix-requests', cursor],
    enabled,
    queryFn: () =>
      apiFetch<SeoSistrixRequestsPageDto>(
        `/seo-advanced/sistrix/requests${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
  });
}

export function useSistrixApiProbe() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'seo'] });
  };
  const probe = useMutation({
    mutationFn: (input: Partial<ProbeSistrixApiInput> & { method: string }) =>
      adminApiFetch<SeoApiProbeResultDto>('/admin/seo/sistrix/api/probe', {
        method: 'POST',
        json: input,
      }),
    onSuccess: refresh,
  });
  return probe;
}

export function useSistrixApiSamples(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'seo', 'sistrix-api-samples'],
    enabled,
    queryFn: () => adminApiFetch<SeoApiSampleDto[]>('/admin/seo/sistrix/api/samples'),
  });
}

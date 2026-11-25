'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SistrixScope } from './sistrix-hooks';
import type {
  SeoOpportunityAssigneeDto,
  SeoOpportunityDetailDto,
  SeoOpportunityPageDto,
  SeoOpportunityRecalcDto,
  SeoOpportunitySettingsDto,
  SeoOpportunitySort,
  SeoOpportunityStatus,
  SeoOpportunitySummaryDto,
  SeoOpportunityType,
  SeoScoredOpportunityDto,
  UpdateSeoOpportunityInput,
  UpdateSeoOpportunitySettingsInput,
} from '@storageos/shared';

import { adminApiFetch, adminApiFetchBlob } from '@/lib/admin/api';
import { apiFetch, apiFetchBlob } from '@/lib/auth/api';

/**
 * Oportunidades del motor propio de un proyecto, desde el panel admin
 * (cualquier proyecto; los de un tenant, en lectura) o desde el del tenant.
 */
export type OpportunityScope = SistrixScope;

type Fetcher = <T>(path: string, options?: { method?: string; json?: unknown }) => Promise<T>;

function scopeApi(scope: OpportunityScope) {
  const fetcher: Fetcher = scope.kind === 'admin' ? adminApiFetch : apiFetch;
  const blob = scope.kind === 'admin' ? adminApiFetchBlob : apiFetchBlob;
  const base =
    scope.kind === 'admin'
      ? `/admin/seo/projects/${scope.projectId}/opportunity-engine`
      : '/seo-advanced/opportunity-engine';
  const key =
    scope.kind === 'admin'
      ? ['admin', 'seo', 'opportunities', scope.projectId]
      : ['seo-advanced', 'opportunities'];
  return { fetcher, blob, base, key };
}

export interface OpportunityFilters {
  types: SeoOpportunityType[];
  statuses: SeoOpportunityStatus[];
  minScore: number | null;
  search: string;
  domainId: string | null;
  sort: SeoOpportunitySort;
}

export function opportunityQueryString(f: OpportunityFilters, extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  if (f.types.length) p.set('type', f.types.join(','));
  if (f.statuses.length) p.set('status', f.statuses.join(','));
  if (f.minScore !== null) p.set('minScore', String(f.minScore));
  if (f.search.trim()) p.set('search', f.search.trim());
  if (f.domainId) p.set('domainId', f.domainId);
  p.set('sort', f.sort);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

export function useOpportunitySummary(scope: OpportunityScope) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'summary'],
    queryFn: () => fetcher<SeoOpportunitySummaryDto>(`${base}/summary`),
  });
}

const PAGE = 50;

export function useOpportunityList(scope: OpportunityScope, filters: OpportunityFilters) {
  const { fetcher, base, key } = scopeApi(scope);
  return useInfiniteQuery({
    queryKey: [...key, 'list', filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetcher<SeoOpportunityPageDto>(
        `${base}?${opportunityQueryString(filters, { offset: String(pageParam), limit: String(PAGE) })}`,
      ),
    getNextPageParam: (last) => (last.hasMore ? last.offset + last.items.length : undefined),
  });
}

export function useOpportunityDetail(scope: OpportunityScope, id: string | null) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'detail', id],
    queryFn: () => fetcher<SeoOpportunityDetailDto>(`${base}/${id}`),
    enabled: !!id,
  });
}

export function useOpportunityAssignees(scope: OpportunityScope, enabled: boolean) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'assignees'],
    queryFn: () => fetcher<SeoOpportunityAssigneeDto[]>(`${base}/assignees`),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useOpportunitySettings(scope: OpportunityScope, enabled: boolean) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'settings'],
    queryFn: () => fetcher<SeoOpportunitySettingsDto>(`${base}/settings`),
    enabled,
  });
}

function useInvalidate(scope: OpportunityScope) {
  const qc = useQueryClient();
  const { key } = scopeApi(scope);
  return () => qc.invalidateQueries({ queryKey: key });
}

export function useUpdateOpportunity(scope: OpportunityScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSeoOpportunityInput }) =>
      fetcher<SeoScoredOpportunityDto>(`${base}/${id}`, { method: 'PATCH', json: input }),
    onSuccess: invalidate,
  });
}

export function useRecalculateOpportunities(scope: OpportunityScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: () => fetcher<SeoOpportunityRecalcDto>(`${base}/recalculate`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useUpdateOpportunitySettings(scope: OpportunityScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: UpdateSeoOpportunitySettingsInput) =>
      fetcher<SeoOpportunitySettingsDto>(`${base}/settings`, { method: 'PUT', json: input }),
    onSuccess: invalidate,
  });
}

/** CSV con los filtros de la lista. */
export function opportunitiesCsv(
  scope: OpportunityScope,
  filters: OpportunityFilters,
): Promise<Blob> {
  const { blob, base } = scopeApi(scope);
  return blob(`${base}/csv?${opportunityQueryString(filters)}`);
}

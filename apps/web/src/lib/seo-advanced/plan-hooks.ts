'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SistrixScope } from './sistrix-hooks';
import type {
  CreateSeoSiteChangeInput,
  CreateSeoTaskInput,
  MoveSeoTaskInput,
  SeoChartMarkerDto,
  SeoSiteChangeDetailDto,
  SeoSiteChangeDto,
  SeoSiteChangeListDto,
  SeoSiteChangeType,
  SeoTaskDto,
  SeoTaskListDto,
  SeoTaskStatus,
  SeoTaskType,
  UpdateSeoSiteChangeInput,
  UpdateSeoTaskInput,
} from '@storageos/shared';

import { adminApiFetch, adminApiFetchBlob } from '@/lib/admin/api';
import { apiFetch, apiFetchBlob } from '@/lib/auth/api';

/**
 * El plan de un proyecto SEO (actuaciones con su antes y después y tareas),
 * desde el panel admin (cualquier proyecto; los de un tenant, en lectura) o
 * desde el del tenant. El mismo «ámbito» que SISTRIX.
 */
export type PlanScope = SistrixScope;

type Fetcher = <T>(path: string, options?: { method?: string; json?: unknown }) => Promise<T>;

function scopeApi(scope: PlanScope) {
  const fetcher: Fetcher = scope.kind === 'admin' ? adminApiFetch : apiFetch;
  const blob = scope.kind === 'admin' ? adminApiFetchBlob : apiFetchBlob;
  const base =
    scope.kind === 'admin' ? `/admin/seo/projects/${scope.projectId}/plan` : '/seo-advanced/plan';
  const key =
    scope.kind === 'admin' ? ['admin', 'seo', 'plan', scope.projectId] : ['seo-advanced', 'plan'];
  return { fetcher, blob, base, key };
}

const qs = (params: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  }
  return p.toString();
};

// ------------------------------------------------------------- actuaciones

export interface ChangeFilters {
  domainId: string | null;
  type: SeoSiteChangeType | null;
  search: string;
}

const PAGE = 30;

export function useSiteChanges(scope: PlanScope, filters: ChangeFilters) {
  const { fetcher, base, key } = scopeApi(scope);
  return useInfiniteQuery({
    queryKey: [...key, 'changes', filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetcher<SeoSiteChangeListDto>(
        `${base}/changes?${qs({ ...filters, search: filters.search.trim(), offset: pageParam, limit: PAGE })}`,
      ),
    getNextPageParam: (last) => (last.hasMore ? last.offset + last.items.length : undefined),
  });
}

export function useSiteChangeDetail(scope: PlanScope, id: string | null) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'changes', 'detail', id],
    queryFn: () => fetcher<SeoSiteChangeDetailDto>(`${base}/changes/${id}`),
    enabled: !!id,
  });
}

/** Marcas de las actuaciones para un gráfico (dominio, fechas y, si se da, búsqueda o URL). */
export function useChangeMarkers(
  scope: PlanScope | undefined,
  params: {
    domainId?: string | null;
    from?: string | null;
    to?: string | null;
    query?: string | null;
    url?: string | null;
  },
  enabled = true,
) {
  const api = scopeApi(scope ?? { kind: 'tenant' });
  return useQuery({
    queryKey: [...api.key, 'markers', params],
    queryFn: () => api.fetcher<SeoChartMarkerDto[]>(`${api.base}/changes/markers?${qs(params)}`),
    enabled: enabled && !!scope,
    staleTime: 60_000,
  });
}

function useInvalidate(scope: PlanScope) {
  const qc = useQueryClient();
  const { key } = scopeApi(scope);
  return () => qc.invalidateQueries({ queryKey: key });
}

export function useCreateSiteChange(scope: PlanScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: CreateSeoSiteChangeInput) =>
      fetcher<SeoSiteChangeDto>(`${base}/changes`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateSiteChange(scope: PlanScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSeoSiteChangeInput }) =>
      fetcher<SeoSiteChangeDto>(`${base}/changes/${id}`, { method: 'PATCH', json: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteSiteChange(scope: PlanScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (id: string) => fetcher<void>(`${base}/changes/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function siteChangesCsv(scope: PlanScope, filters: ChangeFilters): Promise<Blob> {
  const { blob, base } = scopeApi(scope);
  return blob(`${base}/changes/csv?${qs({ ...filters, search: filters.search.trim() })}`);
}

// ------------------------------------------------------------------ tareas

export interface TaskFilters {
  type: SeoTaskType | null;
  /** Id, `none` (sin asignar) o `me` (mis tareas). */
  assignedTo: string | null;
  search: string;
  statuses?: SeoTaskStatus[];
  from?: string | null;
  to?: string | null;
}

function taskQs(f: TaskFilters) {
  return qs({
    type: f.type,
    assignedTo: f.assignedTo,
    search: f.search.trim(),
    status: f.statuses?.length ? f.statuses.join(',') : null,
    from: f.from ?? null,
    to: f.to ?? null,
  });
}

export function useSeoTasks(scope: PlanScope, filters: TaskFilters) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'tasks', filters],
    queryFn: () => fetcher<SeoTaskListDto>(`${base}/tasks?${taskQs(filters)}`),
  });
}

export function useCreateSeoTask(scope: PlanScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: CreateSeoTaskInput) =>
      fetcher<SeoTaskDto>(`${base}/tasks`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateSeoTask(scope: PlanScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSeoTaskInput }) =>
      fetcher<SeoTaskDto>(`${base}/tasks/${id}`, { method: 'PATCH', json: input }),
    onSuccess: invalidate,
  });
}

export function useMoveSeoTask(scope: PlanScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MoveSeoTaskInput }) =>
      fetcher<SeoTaskDto>(`${base}/tasks/${id}/move`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteSeoTask(scope: PlanScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (id: string) => fetcher<void>(`${base}/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function seoTasksCsv(scope: PlanScope, filters: TaskFilters): Promise<Blob> {
  const { blob, base } = scopeApi(scope);
  return blob(`${base}/tasks/csv?${taskQs(filters)}`);
}

/** Descarga un CSV ya pedido. */
export function saveCsv(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

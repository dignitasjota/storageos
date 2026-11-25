'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useMemo } from 'react';

import type {
  SeoCrossDto,
  SeoDashboardDto,
  SeoImportDetailDto,
  SeoImportDto,
  SeoImportPreviewDto,
  SeoPanelPeriod,
  SeoTablePageDto,
  SeoTableSort,
} from '@storageos/shared';

import { adminApiFetch, adminApiFetchBlob } from '@/lib/admin/api';
import { apiFetch, apiFetchBlob } from '@/lib/auth/api';

/**
 * El mismo panel de SEO Avanzado en los dos paneles: el del tenant (su
 * proyecto, `/seo-advanced/...`) y el del admin (cualquier proyecto,
 * `/admin/seo/projects/:id/...`). Cada uno pone su cliente.
 */
export interface SeoPanelClient {
  /** Prefijo de las claves de caché. */
  scope: QueryKey;
  /** Ruta base de la API. */
  base: string;
  get: <T>(path: string) => Promise<T>;
  blob: (path: string) => Promise<Blob>;
  upload: <T>(path: string, form: FormData) => Promise<T>;
  remove: (path: string) => Promise<void>;
  /** Puede importar y borrar importaciones (si no, solo ver). */
  canImport: boolean;
}

export function useTenantSeoClient(canImport: boolean): SeoPanelClient {
  return useMemo(
    () => ({
      scope: ['seo-advanced', 'panel'],
      base: '/seo-advanced',
      get: <T>(path: string) => apiFetch<T>(path),
      blob: (path: string) => apiFetchBlob(path),
      upload: <T>(path: string, form: FormData) =>
        apiFetch<T>(path, { method: 'POST', formData: form }),
      remove: async (path: string) => {
        await apiFetch<void>(path, { method: 'DELETE' });
      },
      canImport,
    }),
    [canImport],
  );
}

export function useAdminSeoClient(projectId: string, canImport: boolean): SeoPanelClient {
  return useMemo(
    () => ({
      scope: ['admin', 'seo', 'panel', projectId],
      base: `/admin/seo/projects/${projectId}`,
      get: <T>(path: string) => adminApiFetch<T>(path),
      blob: (path: string) => adminApiFetchBlob(path),
      upload: <T>(path: string, form: FormData) =>
        adminApiFetch<T>(path, { method: 'POST', formData: form }),
      remove: async (path: string) => {
        await adminApiFetch<void>(path, { method: 'DELETE' });
      },
      canImport,
    }),
    [projectId, canImport],
  );
}

/** Lo que se elige arriba del panel. */
export interface SeoPanelParams {
  period: SeoPanelPeriod;
  /** Solo con «Personalizado». */
  from?: string | undefined;
  to?: string | undefined;
  domainId?: string | null | undefined;
}

export function panelQueryString(p: SeoPanelParams, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ period: p.period, ...extra });
  if (p.period === 'custom' && p.from && p.to) {
    q.set('from', p.from);
    q.set('to', p.to);
  }
  if (p.domainId) q.set('domainId', p.domainId);
  return q.toString();
}

const ready = (p: SeoPanelParams) => p.period !== 'custom' || (!!p.from && !!p.to);

export function useSeoDashboard(client: SeoPanelClient, params: SeoPanelParams, enabled = true) {
  return useQuery({
    queryKey: [...client.scope, 'dashboard', params],
    queryFn: () =>
      client.get<SeoDashboardDto>(`${client.base}/dashboard?${panelQueryString(params)}`),
    enabled: enabled && ready(params),
  });
}

export interface SeoTableParams extends SeoPanelParams {
  search: string;
  sort: SeoTableSort;
  dir?: 'asc' | 'desc' | undefined;
}

const tableExtra = (p: SeoTableParams): Record<string, string> => ({
  sort: p.sort,
  ...(p.dir ? { dir: p.dir } : {}),
  ...(p.search.trim() ? { search: p.search.trim() } : {}),
});

/** Búsquedas o páginas, de 50 en 50 («Cargar más»). */
export function useSeoTable(
  client: SeoPanelClient,
  dimension: 'query' | 'page',
  params: SeoTableParams,
  enabled = true,
) {
  const path = dimension === 'query' ? 'queries' : 'pages';
  return useInfiniteQuery({
    queryKey: [...client.scope, 'table', dimension, params],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      client.get<SeoTablePageDto>(
        `${client.base}/${path}?${panelQueryString(params, {
          ...tableExtra(params),
          offset: String(pageParam),
        })}`,
      ),
    getNextPageParam: (last) => (last.hasMore ? last.offset + last.items.length : undefined),
    enabled: enabled && ready(params),
  });
}

/** El CSV de la tabla (todas las filas, en el orden elegido). */
export function seoTableCsv(
  client: SeoPanelClient,
  dimension: 'query' | 'page',
  params: SeoTableParams,
): Promise<Blob> {
  const path = dimension === 'query' ? 'queries' : 'pages';
  return client.blob(`${client.base}/${path}/csv?${panelQueryString(params, tableExtra(params))}`);
}

/** Una búsqueda → sus páginas, o una página → sus búsquedas. */
export function useSeoCross(
  client: SeoPanelClient,
  dimension: 'query' | 'page',
  value: string | null,
  params: SeoPanelParams,
) {
  return useQuery({
    queryKey: [...client.scope, 'cross', dimension, value, params],
    queryFn: () =>
      client.get<SeoCrossDto>(
        `${client.base}/cross?${panelQueryString(params, { dimension, value: value ?? '' })}`,
      ),
    enabled: !!value && ready(params),
  });
}

export function useSeoImports(client: SeoPanelClient, enabled = true) {
  return useQuery({
    queryKey: [...client.scope, 'imports'],
    queryFn: () => client.get<SeoImportDto[]>(`${client.base}/imports`),
    enabled,
  });
}

export function useSeoImportDetail(client: SeoPanelClient, importId: string | null) {
  return useQuery({
    queryKey: [...client.scope, 'imports', importId],
    queryFn: () => client.get<SeoImportDetailDto>(`${client.base}/imports/${importId}`),
    enabled: !!importId,
  });
}

const importForm = (domainId: string, file: File) => {
  const form = new FormData();
  form.append('domainId', domainId);
  form.append('file', file);
  return form;
};

export function useSeoImportPreview(client: SeoPanelClient) {
  return useMutation({
    mutationFn: ({ domainId, file }: { domainId: string; file: File }) =>
      client.upload<SeoImportPreviewDto>(
        `${client.base}/imports/preview`,
        importForm(domainId, file),
      ),
  });
}

/** Importar y borrar: al terminar se refresca todo el panel (cambian los días). */
export function useSeoImportMutations(client: SeoPanelClient) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: client.scope });
  const create = useMutation({
    mutationFn: ({ domainId, file }: { domainId: string; file: File }) =>
      client.upload<SeoImportDto>(`${client.base}/imports`, importForm(domainId, file)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (importId: string) => client.remove(`${client.base}/imports/${importId}`),
    onSuccess: refresh,
  });
  return { create, remove };
}

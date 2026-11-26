'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SistrixScope } from './sistrix-hooks';
import type {
  SeoKeywordGroupDto,
  SeoMasterImportDetailDto,
  SeoMasterImportDto,
  SeoMasterPreviewDto,
  SeoMasterRemoveResultDto,
} from '@storageos/shared';

import { adminApiFetch } from '@/lib/admin/api';
import { apiFetch } from '@/lib/auth/api';

/**
 * Los Excel maestros de un proyecto SEO, desde el panel admin (cualquier
 * proyecto; los de un tenant, en lectura) o desde el del tenant. El mismo
 * «ámbito» que SISTRIX.
 */
type Fetcher = <T>(path: string, options?: { method?: string; formData?: FormData }) => Promise<T>;

function scopeApi(scope: SistrixScope) {
  const fetcher: Fetcher = scope.kind === 'admin' ? adminApiFetch : apiFetch;
  const base = scope.kind === 'admin' ? `/admin/seo/projects/${scope.projectId}` : '/seo-advanced';
  const key =
    scope.kind === 'admin'
      ? ['admin', 'seo', 'master', scope.projectId]
      : ['seo-advanced', 'master'];
  /** Lo que toca una importación: palabras, competidores, tareas, Search Console… */
  const everything = scope.kind === 'admin' ? ['admin', 'seo'] : ['seo-advanced'];
  return { fetcher, base, key, everything };
}

const fileForm = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return form;
};

export function useMasterImports(scope: SistrixScope) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'list'],
    queryFn: () => fetcher<SeoMasterImportDto[]>(`${base}/master-imports`),
  });
}

export function useMasterImportDetail(scope: SistrixScope, importId: string | null) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'detail', importId],
    queryFn: () => fetcher<SeoMasterImportDetailDto>(`${base}/master-imports/${importId}`),
    enabled: !!importId,
  });
}

export function useKeywordGroups(scope: SistrixScope, enabled = true) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'groups'],
    queryFn: () => fetcher<SeoKeywordGroupDto[]>(`${base}/keyword-groups`),
    enabled,
  });
}

/** Lo que haría la importación (no guarda nada). */
export function useMasterPreview(scope: SistrixScope) {
  const { fetcher, base } = scopeApi(scope);
  return useMutation({
    mutationFn: (file: File) =>
      fetcher<SeoMasterPreviewDto>(`${base}/master-imports/preview`, {
        method: 'POST',
        formData: fileForm(file),
      }),
  });
}

/** Importar y borrar: al terminar se refresca todo el proyecto (cambian muchas cosas). */
export function useMasterImportMutations(scope: SistrixScope) {
  const { fetcher, base, everything } = scopeApi(scope);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: everything });
  const create = useMutation({
    mutationFn: (file: File) =>
      fetcher<SeoMasterImportDto>(`${base}/master-imports`, {
        method: 'POST',
        formData: fileForm(file),
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (importId: string) =>
      fetcher<SeoMasterRemoveResultDto>(`${base}/master-imports/${importId}`, {
        method: 'DELETE',
      }),
    onSuccess: refresh,
  });
  return { create, remove };
}

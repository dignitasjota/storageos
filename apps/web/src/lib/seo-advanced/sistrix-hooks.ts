'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AddSeoProjectKeywordsInput,
  CreateSeoCompetitorInput,
  SeoAiVisibilityRowDto,
  SeoBacklinksDto,
  SeoCompetitorDto,
  SeoDomainKeywordHistoryDto,
  SeoDomainKeywordsDto,
  SeoOpportunitiesDto,
  SeoProjectKeywordDto,
  SeoSerpDto,
  SeoSistrixApiDto,
  SeoSistrixDataType,
  SeoSistrixIntegrationsDto,
  SeoSistrixRequestsPageDto,
  SeoSistrixRunDto,
  SeoSistrixTestResultDto,
  SeoSistrixWorkspaceDto,
  SeoSyncSettingsDto,
  SeoTenantSistrixDto,
  SeoVisibilitySeriesDto,
  UpdateSeoCompetitorInput,
  UpdateSeoProjectKeywordInput,
  UpdateSeoSyncSettingsInput,
  UpdateSistrixApiSettingsInput,
} from '@storageos/shared';

import { adminApiFetch } from '@/lib/admin/api';
import { apiFetch } from '@/lib/auth/api';

/**
 * Datos de SISTRIX de un proyecto, desde el panel admin (cualquier proyecto;
 * los de un tenant, en lectura) o desde el del tenant (el suyo). Las mismas
 * pantallas sirven para los dos con este «ámbito».
 */
export type SistrixScope = { kind: 'admin'; projectId: string } | { kind: 'tenant' };

type Fetcher = <T>(path: string, options?: { method?: string; json?: unknown }) => Promise<T>;

function scopeApi(scope: SistrixScope) {
  const fetcher: Fetcher = scope.kind === 'admin' ? adminApiFetch : apiFetch;
  const base = scope.kind === 'admin' ? `/admin/seo/projects/${scope.projectId}` : '/seo-advanced';
  const key =
    scope.kind === 'admin'
      ? ['admin', 'seo', 'sistrix', scope.projectId]
      : ['seo-advanced', 'sistrix'];
  const runs = scope.kind === 'admin' ? '/admin/seo/sistrix/runs' : '/seo-advanced/sistrix/runs';
  return { fetcher, base, key, runs };
}

/** Mientras haya una tanda en marcha se refresca cada 3 s. */
const POLL_MS = 3000;
const hasActive = (runs: SeoSistrixRunDto[] | undefined) =>
  !!runs?.some((r) => r.status === 'queued' || r.status === 'running');

/** Estado de SISTRIX en el proyecto (y, en el tenant, su clave de API). */
export function useSistrixWorkspace(scope: SistrixScope, enabled = true) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, 'workspace'],
    enabled,
    queryFn: async (): Promise<{
      workspace: SeoSistrixWorkspaceDto | null;
      settings: SeoTenantSistrixDto | null;
    }> => {
      if (scope.kind === 'admin') {
        return {
          workspace: await fetcher<SeoSistrixWorkspaceDto>(`${base}/sistrix`),
          settings: null,
        };
      }
      return fetcher('/seo-advanced/sistrix');
    },
    refetchInterval: (q) => (hasActive(q.state.data?.workspace?.runs) ? POLL_MS : false),
  });
}

function useInvalidate(scope: SistrixScope) {
  const qc = useQueryClient();
  const { key } = scopeApi(scope);
  return () => qc.invalidateQueries({ queryKey: key });
}

export function useSistrixSync(scope: SistrixScope) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  const path = scope.kind === 'admin' ? `${base}/sistrix/sync` : '/seo-advanced/sistrix/sync';
  return useMutation({
    mutationFn: (dataType: SeoSistrixDataType) =>
      fetcher<SeoSistrixRunDto>(path, { method: 'POST', json: { dataType } }),
    onSuccess: invalidate,
  });
}

export function useCancelSistrixRun(scope: SistrixScope) {
  const { fetcher, runs } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (runId: string) =>
      fetcher<SeoSistrixRunDto>(`${runs}/${runId}/cancel`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

function useList<T>(scope: SistrixScope, path: string, name: string, enabled = true) {
  const { fetcher, base, key } = scopeApi(scope);
  return useQuery({
    queryKey: [...key, name, path],
    queryFn: () => fetcher<T>(`${base}${path}`),
    enabled,
  });
}

export const useSistrixCompetitors = (scope: SistrixScope) =>
  useList<SeoCompetitorDto[]>(scope, '/competitors', 'competitors');
export const useSistrixVisibility = (scope: SistrixScope) =>
  useList<SeoVisibilitySeriesDto[]>(scope, '/visibility', 'visibility');
export const useSistrixKeywords = (scope: SistrixScope) =>
  useList<SeoProjectKeywordDto[]>(scope, '/keywords', 'keywords');
export const useSistrixOpportunities = (scope: SistrixScope, kind: 'opportunity' | 'idea') =>
  useList<SeoOpportunitiesDto>(scope, `/opportunities?kind=${kind}`, 'opportunities');
export const useSistrixBacklinks = (scope: SistrixScope) =>
  useList<SeoBacklinksDto>(scope, '/backlinks', 'backlinks');
export const useSistrixAiVisibility = (scope: SistrixScope) =>
  useList<SeoAiVisibilityRowDto[]>(scope, '/ai-visibility', 'ai');
export const useSistrixDomainKeywords = (scope: SistrixScope, domain: string | null) =>
  useList<SeoDomainKeywordsDto>(
    scope,
    `/domain-keywords?domain=${encodeURIComponent(domain ?? '')}`,
    'domain-keywords',
    !!domain,
  );
export const useSistrixDomainKeywordHistory = (
  scope: SistrixScope,
  domain: string | null,
  keyword: string | null,
) =>
  useList<SeoDomainKeywordHistoryDto>(
    scope,
    `/domain-keywords/history?domain=${encodeURIComponent(domain ?? '')}&keyword=${encodeURIComponent(keyword ?? '')}`,
    'domain-keyword-history',
    !!domain && !!keyword,
  );
export const useSistrixSerp = (scope: SistrixScope, keywordId: string | null) =>
  useList<SeoSerpDto>(scope, `/keywords/${keywordId ?? ''}/serp`, 'serp', !!keywordId);

function useWrite<I, O>(
  scope: SistrixScope,
  method: string,
  path: (input: I) => string,
  body: (input: I) => unknown,
) {
  const { fetcher, base } = scopeApi(scope);
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: (input: I) => fetcher<O>(`${base}${path(input)}`, { method, json: body(input) }),
    onSuccess: invalidate,
  });
}

export const useAddCompetitor = (scope: SistrixScope) =>
  useWrite<CreateSeoCompetitorInput, SeoCompetitorDto[]>(
    scope,
    'POST',
    () => '/competitors',
    (i) => i,
  );
export const useUpdateCompetitor = (scope: SistrixScope) =>
  useWrite<{ id: string } & UpdateSeoCompetitorInput, SeoCompetitorDto[]>(
    scope,
    'PATCH',
    (i) => `/competitors/${i.id}`,
    ({ id: _id, ...rest }) => rest,
  );
export const useRemoveCompetitor = (scope: SistrixScope) =>
  useWrite<string, SeoCompetitorDto[]>(
    scope,
    'DELETE',
    (id) => `/competitors/${id}`,
    () => undefined,
  );
export const useAddKeywords = (scope: SistrixScope) =>
  useWrite<Partial<AddSeoProjectKeywordsInput> & { keywords: string[] }, SeoProjectKeywordDto[]>(
    scope,
    'POST',
    () => '/keywords',
    (i) => i,
  );
export const useUpdateKeyword = (scope: SistrixScope) =>
  useWrite<{ id: string } & UpdateSeoProjectKeywordInput, SeoProjectKeywordDto[]>(
    scope,
    'PATCH',
    (i) => `/keywords/${i.id}`,
    ({ id: _id, ...rest }) => rest,
  );
export const useRemoveKeyword = (scope: SistrixScope) =>
  useWrite<string, SeoProjectKeywordDto[]>(
    scope,
    'DELETE',
    (id) => `/keywords/${id}`,
    () => undefined,
  );

// ------------------------------------------------------- tenant: su clave

export function useUpdateTenantSistrixApi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSistrixApiSettingsInput) =>
      apiFetch<SeoSistrixApiDto>('/seo-advanced/sistrix/api', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['seo-advanced', 'sistrix'] }),
  });
}

export function useTestTenantSistrixApi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<SeoSistrixTestResultDto>('/seo-advanced/sistrix/api/test', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['seo-advanced', 'sistrix'] }),
  });
}

export function useUpdateTenantSistrixSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSeoSyncSettingsInput) =>
      apiFetch<SeoSyncSettingsDto>('/seo-advanced/sistrix/settings', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['seo-advanced', 'sistrix'] }),
  });
}

// ---------------------------------------------- panel admin: integraciones

const adminRoot = ['admin', 'seo', 'sistrix-integrations'] as const;

export function useSistrixIntegrations() {
  return useQuery({
    queryKey: [...adminRoot],
    queryFn: () => adminApiFetch<SeoSistrixIntegrationsDto>('/admin/seo/sistrix'),
    refetchInterval: (q) => (q.state.data?.pending.length ? POLL_MS : false),
  });
}

function useAdminAction<I, O>(fn: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'seo'] }),
  });
}

export const useConnectSistrix = () =>
  useAdminAction(() =>
    adminApiFetch<{ authorizationUrl: string }>('/admin/seo/sistrix/connect', { method: 'POST' }),
  );
export const useTestSistrix = () =>
  useAdminAction(() =>
    adminApiFetch<SeoSistrixTestResultDto>('/admin/seo/sistrix/test', { method: 'POST' }),
  );
export const useRefreshSistrixTools = () =>
  useAdminAction(() =>
    adminApiFetch<SeoSistrixIntegrationsDto>('/admin/seo/sistrix/tools/refresh', {
      method: 'POST',
    }),
  );
export const useDisconnectSistrix = () =>
  useAdminAction(() =>
    adminApiFetch<SeoSistrixIntegrationsDto>('/admin/seo/sistrix/connection', { method: 'DELETE' }),
  );
export const useUpdatePlatformSistrixApi = () =>
  useAdminAction((input: UpdateSistrixApiSettingsInput) =>
    adminApiFetch<SeoSistrixApiDto>('/admin/seo/sistrix/api', { method: 'PUT', json: input }),
  );
export const useTestPlatformSistrixApi = () =>
  useAdminAction(() =>
    adminApiFetch<SeoSistrixTestResultDto>('/admin/seo/sistrix/api/test', { method: 'POST' }),
  );
export const useAuthorizeSistrixApi = () =>
  useAdminAction(() =>
    adminApiFetch<SeoSistrixIntegrationsDto>('/admin/seo/sistrix/api/authorize', {
      method: 'POST',
    }),
  );
export const useRevokeSistrixApi = () =>
  useAdminAction(() =>
    adminApiFetch<SeoSistrixIntegrationsDto>('/admin/seo/sistrix/api/authorize', {
      method: 'DELETE',
    }),
  );
export const useUpdatePlatformSyncSettings = () =>
  useAdminAction((input: UpdateSeoSyncSettingsInput) =>
    adminApiFetch<SeoSyncSettingsDto>('/admin/seo/sistrix/settings', {
      method: 'PUT',
      json: input,
    }),
  );
export const useCancelPlatformSistrixRun = () =>
  useAdminAction((runId: string) =>
    adminApiFetch<SeoSistrixRunDto>(`/admin/seo/sistrix/runs/${runId}/cancel`, { method: 'POST' }),
  );
export const useSetProjectPlatformSistrix = (projectId: string) =>
  useAdminAction((usePlatformSistrix: boolean) =>
    adminApiFetch<SeoSistrixWorkspaceDto>(`/admin/seo/projects/${projectId}/sistrix-platform`, {
      method: 'PATCH',
      json: { usePlatformSistrix },
    }),
  );

export function useSistrixRequests(filters: {
  status: string;
  provider: string;
  cursor: string | null;
}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.provider) params.set('provider', filters.provider);
  if (filters.cursor) params.set('cursor', filters.cursor);
  return useQuery({
    queryKey: ['admin', 'seo', 'sistrix-requests', filters],
    queryFn: () =>
      adminApiFetch<SeoSistrixRequestsPageDto>(`/admin/seo/sistrix/requests?${params.toString()}`),
  });
}

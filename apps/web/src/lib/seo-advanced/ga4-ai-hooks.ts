'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SistrixScope } from './sistrix-hooks';
import type {
  ConnectSeoGa4Input,
  SeoAiVisibilityReportDto,
  SeoAiVisibilitySettings,
  SeoGa4PageDetailDto,
  SeoGa4PagesDto,
  SeoGa4SettingsDto,
  SeoPagePerformanceSort,
  SeoPanelPeriod,
} from '@storageos/shared';

import { adminApiFetch } from '@/lib/admin/api';
import { apiFetch } from '@/lib/auth/api';

/**
 * PR 12: Google Analytics del tráfico orgánico y visibilidad en buscadores de
 * IA de un proyecto SEO, desde el panel admin (cualquier proyecto; los de un
 * tenant, en lectura) o desde el del tenant. El mismo «ámbito» que SISTRIX.
 */
export type Ga4AiScope = SistrixScope;

type Fetcher = <T>(path: string, options?: { method?: string; json?: unknown }) => Promise<T>;

function scopeApi(scope: Ga4AiScope) {
  const fetcher: Fetcher = scope.kind === 'admin' ? adminApiFetch : apiFetch;
  const base = scope.kind === 'admin' ? `/admin/seo/projects/${scope.projectId}` : '/seo-advanced';
  const root = scope.kind === 'admin' ? ['admin', 'seo'] : ['seo-advanced'];
  const id = scope.kind === 'admin' ? [scope.projectId] : [];
  return { fetcher, base, ga4Key: [...root, 'ga4', ...id], aiKey: [...root, 'ai', ...id] };
}

const qs = (params: Record<string, string | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  return p.toString();
};

// --------------------------------------------------------------------- GA4

export function useSeoGa4Settings(scope: Ga4AiScope) {
  const { fetcher, base, ga4Key } = scopeApi(scope);
  return useQuery({
    queryKey: [...ga4Key, 'settings'],
    queryFn: () => fetcher<SeoGa4SettingsDto>(`${base}/ga4`),
    // Mientras se descarga la carga inicial, se mira cada 3 s.
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 3000 : false),
  });
}

function useGa4Mutation<TInput>(
  scope: Ga4AiScope,
  run: (fetcher: Fetcher, base: string, input: TInput) => Promise<SeoGa4SettingsDto>,
) {
  const qc = useQueryClient();
  const { fetcher, base, ga4Key } = scopeApi(scope);
  return useMutation({
    mutationFn: (input: TInput) => run(fetcher, base, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ga4Key }),
  });
}

export const useConnectSeoGa4 = (scope: Ga4AiScope) =>
  useGa4Mutation<ConnectSeoGa4Input>(scope, (f, base, input) =>
    f<SeoGa4SettingsDto>(`${base}/ga4`, { method: 'PUT', json: input }),
  );

export const useDisconnectSeoGa4 = (scope: Ga4AiScope) =>
  useGa4Mutation<void>(scope, (f, base) =>
    f<SeoGa4SettingsDto>(`${base}/ga4`, { method: 'DELETE' }),
  );

export const useSyncSeoGa4 = (scope: Ga4AiScope) =>
  useGa4Mutation<void>(scope, (f, base) =>
    f<SeoGa4SettingsDto>(`${base}/ga4/sync`, { method: 'POST' }),
  );

export function useSeoGa4Pages(
  scope: Ga4AiScope,
  q: { period: SeoPanelPeriod; sort: SeoPagePerformanceSort; domainId?: string | null },
) {
  const { fetcher, base, ga4Key } = scopeApi(scope);
  return useQuery({
    queryKey: [...ga4Key, 'pages', q.period, q.sort, q.domainId ?? null],
    queryFn: () =>
      fetcher<SeoGa4PagesDto>(
        `${base}/ga4/pages?${qs({ period: q.period, sort: q.sort, domainId: q.domainId })}`,
      ),
  });
}

/** Las cifras de GA4 de una página (ficha de la página o de la palabra). */
export function useSeoGa4Page(scope: Ga4AiScope, url: string | null, days = 90) {
  const { fetcher, base, ga4Key } = scopeApi(scope);
  return useQuery({
    queryKey: [...ga4Key, 'page', url, days],
    queryFn: () =>
      fetcher<SeoGa4PageDetailDto>(`${base}/ga4/page?${qs({ url, days: String(days) })}`),
    enabled: !!url,
  });
}

// ------------------------------------------------------- visibilidad en IA

export function useSeoAiVisibility(scope: Ga4AiScope) {
  const { fetcher, base, aiKey } = scopeApi(scope);
  return useQuery({
    queryKey: [...aiKey, 'report'],
    queryFn: () => fetcher<SeoAiVisibilityReportDto>(`${base}/ai-visibility/report`),
  });
}

export function useSetSeoAiTrackedPrompts(scope: Ga4AiScope) {
  const qc = useQueryClient();
  const { fetcher, base, aiKey } = scopeApi(scope);
  return useMutation({
    mutationFn: (prompts: string[]) =>
      fetcher<SeoAiVisibilitySettings>(`${base}/ai-visibility/tracked-prompts`, {
        method: 'PUT',
        json: { prompts },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiKey }),
  });
}

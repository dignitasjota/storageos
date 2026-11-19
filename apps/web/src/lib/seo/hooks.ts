'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CreateTrackedKeywordInput,
  SeoDetailDto,
  SeoGoogleFunnelDto,
  TrackedKeywordDto,
  UpdateSeoSettingsInput,
  SearchConsoleSettingsDto,
  SeoMonthlyReportDto,
  SeoPositionsDto,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const settingsKey = ['seo', 'search-console'] as const;

export function useSearchConsole() {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => apiFetch<SearchConsoleSettingsDto>('/seo/search-console'),
  });
}

export function useSeoPositions(days: number, enabled: boolean) {
  return useQuery({
    queryKey: ['seo', 'positions', days],
    queryFn: () => apiFetch<SeoPositionsDto>(`/seo/positions?days=${days}`),
    enabled,
  });
}

function useSettingsMutation(fn: (siteUrl?: string) => Promise<SearchConsoleSettingsDto>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(settingsKey, data);
      void qc.invalidateQueries({ queryKey: ['seo', 'positions'] });
    },
    onError: () => void qc.invalidateQueries({ queryKey: settingsKey }),
  });
}

export function useConnectSearchConsole() {
  return useSettingsMutation((siteUrl) =>
    apiFetch<SearchConsoleSettingsDto>('/seo/search-console', {
      method: 'PUT',
      json: { siteUrl },
    }),
  );
}

export function useDisconnectSearchConsole() {
  return useSettingsMutation(() =>
    apiFetch<SearchConsoleSettingsDto>('/seo/search-console', { method: 'DELETE' }),
  );
}

export function useSyncSearchConsole() {
  return useSettingsMutation(() =>
    apiFetch<SearchConsoleSettingsDto>('/seo/search-console/sync', { method: 'POST' }),
  );
}

export function useSeoReport(enabled: boolean) {
  return useQuery({
    queryKey: ['seo', 'report'],
    queryFn: () => apiFetch<SeoMonthlyReportDto>('/seo/report'),
    enabled,
  });
}

export function useToggleSeoReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<SearchConsoleSettingsDto>('/seo/search-console/report', {
        method: 'PUT',
        json: { enabled },
      }),
    onSuccess: (data) => qc.setQueryData(settingsKey, data),
  });
}

export function useSendSeoReport() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ recipients: number; month: string }>('/seo/report/send', { method: 'POST' }),
  });
}

// --- Mejoras (2026-11-19) ---

export function useUpdateSeoSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSeoSettingsInput) =>
      apiFetch<SearchConsoleSettingsDto>('/seo/search-console/settings', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(settingsKey, data);
      void qc.invalidateQueries({ queryKey: ['seo', 'positions'] });
    },
  });
}

export function useTrackedKeywords(days: number, enabled: boolean) {
  return useQuery({
    queryKey: ['seo', 'keywords', days],
    queryFn: () => apiFetch<TrackedKeywordDto[]>(`/seo/keywords?days=${days}`),
    enabled,
  });
}

export function useAddTrackedKeyword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTrackedKeywordInput) =>
      apiFetch<void>('/seo/keywords', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['seo', 'keywords'] }),
  });
}

export function useRemoveTrackedKeyword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/seo/keywords/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['seo', 'keywords'] }),
  });
}

export function useSeoDetail(target: { kind: 'query' | 'page'; key: string } | null, days: number) {
  return useQuery({
    queryKey: ['seo', 'detail', target?.kind, target?.key, days],
    queryFn: () =>
      apiFetch<SeoDetailDto>(
        `/seo/detail?${target!.kind}=${encodeURIComponent(target!.key)}&days=${days}`,
      ),
    enabled: !!target,
  });
}

export function useSeoGoogleFunnel(days: number, enabled: boolean) {
  return useQuery({
    queryKey: ['seo', 'google-funnel', days],
    queryFn: () => apiFetch<SeoGoogleFunnelDto>(`/seo/google-funnel?days=${days}`),
    enabled,
  });
}

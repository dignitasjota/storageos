'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
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

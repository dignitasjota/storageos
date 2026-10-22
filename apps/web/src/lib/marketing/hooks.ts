'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AdCampaignDraftDto,
  AdPerformanceDto,
  AdPlatformTestResultDto,
  CreateMarketingChannelInput,
  Ga4ReportDto,
  Ga4SettingsDto,
  GoogleAdsSettingsDto,
  MarketingChannelDto,
  MarketingPerformanceDto,
  MarketingSummaryDto,
  MetaAdsSettingsDto,
  ConnectSocialInput,
  SocialReportDto,
  SocialSettingsDto,
  SuggestAdCampaignInput,
  SyncAdSpendInput,
  SyncAdSpendResultDto,
  UpdateGoogleAdsSettingsInput,
  UpdateMarketingChannelInput,
  UpdateMetaAdsSettingsInput,
  WebAnalyticsDto,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const key = ['marketing', 'channels'] as const;

export function useMarketingChannels(status?: string) {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : '';
  return useQuery({
    queryKey: [...key, status ?? 'all'],
    queryFn: () => apiFetch<MarketingChannelDto[]>(`/marketing/channels${suffix}`),
  });
}

export function useMarketingPerformance(filters: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (filters.from) qs.set('from', filters.from);
  if (filters.to) qs.set('to', filters.to);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['marketing', 'performance', filters],
    queryFn: () => apiFetch<MarketingPerformanceDto>(`/marketing/channels/performance${suffix}`),
  });
}

const summaryKey = ['marketing', 'summary'] as const;

/** Resumen de marketing de un mes (`YYYY-MM`; por defecto, el pasado). */
export function useMarketingSummary(month: string | null) {
  return useQuery({
    queryKey: [...summaryKey, month ?? 'last'],
    queryFn: () =>
      apiFetch<MarketingSummaryDto>(`/marketing/summary${month ? `?month=${month}` : ''}`),
  });
}

/** Activa o apaga el correo mensual «Tu marketing en <mes>». */
export function useSetMarketingReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<void>('/marketing/summary/report', { method: 'PUT', json: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: summaryKey }),
  });
}

export function useSendMarketingReport() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ recipients: number; month: string }>('/marketing/summary/report/send', {
        method: 'POST',
      }),
  });
}

/** Visitas y orígenes de la web del tenant (7, 30 o 90 días). */
export function useWebAnalytics(days: number) {
  return useQuery({
    queryKey: ['marketing', 'web-analytics', days],
    queryFn: () => apiFetch<WebAnalyticsDto>(`/marketing/web-analytics?days=${days}`),
  });
}

const ga4Key = ['marketing', 'ga4'] as const;

/** Conexión con Google Analytics 4 (Web Premium). */
export function useGa4Settings(enabled = true) {
  return useQuery({
    queryKey: [...ga4Key, 'settings'],
    queryFn: () => apiFetch<Ga4SettingsDto>('/marketing/ga4'),
    enabled,
  });
}

export function useGa4Report(days: number, enabled = true) {
  return useQuery({
    queryKey: [...ga4Key, 'report', days],
    queryFn: () => apiFetch<Ga4ReportDto>(`/marketing/ga4/report?days=${days}`),
    enabled,
  });
}

/** Conectar (`propertyId`), desconectar (`null`) o actualizar ya (`'sync'`). */
export function useGa4Action() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: { propertyId: string } | null | 'sync') =>
      action === 'sync'
        ? apiFetch<Ga4SettingsDto>('/marketing/ga4/sync', { method: 'POST' })
        : action === null
          ? apiFetch<Ga4SettingsDto>('/marketing/ga4', { method: 'DELETE' })
          : apiFetch<Ga4SettingsDto>('/marketing/ga4', { method: 'PUT', json: action }),
    onSettled: () => qc.invalidateQueries({ queryKey: ga4Key }),
  });
}

const socialKey = ['marketing', 'social'] as const;

/** Conexión con Instagram y Facebook (Web Premium). */
export function useSocialSettings(enabled = true) {
  return useQuery({
    queryKey: [...socialKey, 'settings'],
    queryFn: () => apiFetch<SocialSettingsDto>('/marketing/social'),
    enabled,
  });
}

/** Cifras de Instagram y Facebook de los últimos `days` días. */
export function useSocialReport(days: number) {
  return useQuery({
    queryKey: [...socialKey, 'report', days],
    queryFn: () => apiFetch<SocialReportDto>(`/marketing/social/report?days=${days}`),
  });
}

/** Conectar (token y página), desconectar (`null`) o actualizar ya (`'sync'`). */
export function useSocialAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: ConnectSocialInput | null | 'sync') =>
      action === 'sync'
        ? apiFetch<SocialSettingsDto>('/marketing/social/sync', { method: 'POST' })
        : action === null
          ? apiFetch<SocialSettingsDto>('/marketing/social', { method: 'DELETE' })
          : apiFetch<SocialSettingsDto>('/marketing/social', { method: 'PUT', json: action }),
    onSettled: () => qc.invalidateQueries({ queryKey: socialKey }),
  });
}

/** Rendimiento de las campañas de Google Ads y Meta Ads vinculadas a un canal. */
export function useAdsPerformance(filters: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (filters.from) qs.set('from', filters.from);
  if (filters.to) qs.set('to', filters.to);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['marketing', 'ads-performance', filters],
    queryFn: () => apiFetch<AdPerformanceDto>(`/marketing/channels/ads-performance${suffix}`),
  });
}

export function useCreateMarketingChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMarketingChannelInput) =>
      apiFetch<MarketingChannelDto>('/marketing/channels', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useUpdateMarketingChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateMarketingChannelInput }) =>
      apiFetch<MarketingChannelDto>(`/marketing/channels/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDeleteMarketingChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/marketing/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useSyncAdSpend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { channelId: string; input?: SyncAdSpendInput }) =>
      apiFetch<SyncAdSpendResultDto>(`/marketing/channels/${args.channelId}/sync-ad-spend`, {
        method: 'POST',
        json: args.input ?? {},
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
}

export function useSuggestAdCampaign() {
  return useMutation({
    mutationFn: (input: SuggestAdCampaignInput) =>
      apiFetch<AdCampaignDraftDto>('/marketing/ad-campaign-draft', { method: 'POST', json: input }),
  });
}

// --- Google Ads ---

const googleAdsKey = ['marketing', 'google-ads-settings'] as const;

export function useGoogleAdsSettings() {
  return useQuery({
    queryKey: googleAdsKey,
    queryFn: () => apiFetch<GoogleAdsSettingsDto>('/settings/marketing/google-ads'),
  });
}

export function useUpdateGoogleAdsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateGoogleAdsSettingsInput) =>
      apiFetch<GoogleAdsSettingsDto>('/settings/marketing/google-ads', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: googleAdsKey }),
  });
}

export function useTestGoogleAds() {
  return useMutation({
    mutationFn: () =>
      apiFetch<AdPlatformTestResultDto>('/settings/marketing/google-ads/test', { method: 'POST' }),
  });
}

// --- Meta Ads ---

const metaAdsKey = ['marketing', 'meta-ads-settings'] as const;

export function useMetaAdsSettings() {
  return useQuery({
    queryKey: metaAdsKey,
    queryFn: () => apiFetch<MetaAdsSettingsDto>('/settings/marketing/meta-ads'),
  });
}

export function useUpdateMetaAdsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMetaAdsSettingsInput) =>
      apiFetch<MetaAdsSettingsDto>('/settings/marketing/meta-ads', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: metaAdsKey }),
  });
}

export function useTestMetaAds() {
  return useMutation({
    mutationFn: () =>
      apiFetch<AdPlatformTestResultDto>('/settings/marketing/meta-ads/test', { method: 'POST' }),
  });
}

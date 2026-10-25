import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CampaignEmailPreviewDto,
  CampaignEmailPreviewInput,
  CampaignResultsDto,
  CampaignTemplateDto,
  CreateCampaignTemplateInput,
  WinbackStatsDto,
  CampaignDto,
  CampaignPreviewDto,
  CampaignSegmentInput,
  CreateCampaignInput,
  UpdateWinbackSettingsInput,
  WinbackRunResultDto,
  WinbackSettingsResponse,
} from '@storageos/shared';

const campaignsKey = ['campaigns'] as const;
const winbackKey = ['campaigns', 'winback-settings'] as const;

export function useWinbackSettings() {
  return useQuery({
    queryKey: winbackKey,
    queryFn: () => apiFetch<WinbackSettingsResponse>('/campaigns/winback-settings'),
  });
}

export function useUpdateWinbackSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWinbackSettingsInput) =>
      apiFetch<WinbackSettingsResponse>('/campaigns/winback-settings', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: winbackKey }),
  });
}

export function useRunWinback() {
  return useMutation({
    mutationFn: () => apiFetch<WinbackRunResultDto>('/campaigns/winback/run', { method: 'POST' }),
  });
}

export function useCampaigns() {
  return useQuery({
    queryKey: campaignsKey,
    queryFn: () => apiFetch<CampaignDto[]>('/campaigns'),
    // Mientras alguna se está enviando (en segundo plano), refresca cada 3 s.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((c) => c.status === 'sending') ? 3000 : false,
  });
}

export function useCampaign(id: string | undefined) {
  return useQuery({
    queryKey: [...campaignsKey, id] as const,
    queryFn: () => apiFetch<CampaignDto>(`/campaigns/${id}`),
    enabled: !!id,
  });
}

export function usePreviewCampaign() {
  return useMutation({
    mutationFn: (segment: CampaignSegmentInput) =>
      apiFetch<CampaignPreviewDto>('/campaigns/preview', { method: 'POST', json: { segment } }),
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCampaignInput) =>
      apiFetch<CampaignDto>('/campaigns', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignsKey }),
  });
}

export function useCancelCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<CampaignDto>(`/campaigns/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignsKey }),
  });
}

export function useSendCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<CampaignDto>(`/campaigns/${id}/send`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignsKey }),
  });
}

export function useCampaignResults(id: string | null) {
  return useQuery({
    queryKey: [...campaignsKey, 'results', id] as const,
    queryFn: () => apiFetch<CampaignResultsDto>(`/campaigns/${id}/results`),
    enabled: !!id,
  });
}

export function useWinbackStats() {
  return useQuery({
    queryKey: [...campaignsKey, 'winback-stats'] as const,
    queryFn: () => apiFetch<WinbackStatsDto>('/campaigns/winback/stats'),
  });
}

const templatesKey = [...campaignsKey, 'templates'] as const;

export function useCampaignTemplates() {
  return useQuery({
    queryKey: templatesKey,
    queryFn: () => apiFetch<CampaignTemplateDto[]>('/campaigns/templates'),
  });
}

export function useCreateCampaignTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCampaignTemplateInput) =>
      apiFetch<CampaignTemplateDto>('/campaigns/templates', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: templatesKey }),
  });
}

export function useDeleteCampaignTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/campaigns/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: templatesKey }),
  });
}

export function usePreviewCampaignEmail() {
  return useMutation({
    mutationFn: (input: CampaignEmailPreviewInput) =>
      apiFetch<CampaignEmailPreviewDto>('/campaigns/preview-email', {
        method: 'POST',
        json: input,
      }),
  });
}

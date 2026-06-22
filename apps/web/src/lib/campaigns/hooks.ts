import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CampaignDto,
  CampaignPreviewDto,
  CampaignSegmentInput,
  CreateCampaignInput,
} from '@storageos/shared';

const campaignsKey = ['campaigns'] as const;

export function useCampaigns() {
  return useQuery({
    queryKey: campaignsKey,
    queryFn: () => apiFetch<CampaignDto[]>('/campaigns'),
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

export function useSendCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<CampaignDto>(`/campaigns/${id}/send`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignsKey }),
  });
}

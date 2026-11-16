import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CampaignAutomationDto,
  CampaignAutomationKind,
  CampaignChannel,
  CampaignRecipientDto,
  CampaignRecipientFilter,
  CampaignSavedSegmentDto,
  CampaignTestSendInput,
  CampaignTestSendResultDto,
  SaveCampaignSegmentInput,
  UpdateCampaignAutomationInput,
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
  UpdateCampaignInput,
  UpdateCampaignTemplateInput,
  UpdateWinbackSettingsInput,
  WinbackPreviewDto,
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<WinbackRunResultDto>('/campaigns/winback/run', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...campaignsKey, 'winback-stats'] }),
  });
}

/** A cuántos ex-clientes escribiría «Enviar ahora» (se pide al pulsarlo). */
export function useWinbackPreview() {
  return useMutation({
    mutationFn: () => apiFetch<WinbackPreviewDto>('/campaigns/winback/preview'),
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
    mutationFn: ({
      segment,
      channel = 'email',
    }: {
      segment: CampaignSegmentInput;
      channel?: CampaignChannel;
    }) =>
      apiFetch<CampaignPreviewDto>('/campaigns/preview', {
        method: 'POST',
        json: { segment, channel },
      }),
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

export function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCampaignInput }) =>
      apiFetch<CampaignDto>(`/campaigns/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignsKey }),
  });
}

export function useDuplicateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<CampaignDto>(`/campaigns/${id}/duplicate`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignsKey }),
  });
}

export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/campaigns/${id}`, { method: 'DELETE' }),
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

export function useUpdateCampaignTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCampaignTemplateInput }) =>
      apiFetch<CampaignTemplateDto>(`/campaigns/templates/${id}`, { method: 'PATCH', json: input }),
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

/** Envía el correo de ejemplo a quien lo pide. */
export function useCampaignTestSend() {
  return useMutation({
    mutationFn: (input: CampaignTestSendInput) =>
      apiFetch<CampaignTestSendResultDto>('/campaigns/test-send', { method: 'POST', json: input }),
  });
}

const segmentsKey = [...campaignsKey, 'segments'] as const;

export function useCampaignSegments() {
  return useQuery({
    queryKey: segmentsKey,
    queryFn: () => apiFetch<CampaignSavedSegmentDto[]>('/campaigns/segments'),
  });
}

export function useSaveCampaignSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveCampaignSegmentInput) =>
      apiFetch<CampaignSavedSegmentDto>('/campaigns/segments', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: segmentsKey }),
  });
}

export function useDeleteCampaignSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/campaigns/segments/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: segmentsKey }),
  });
}

/** Quién la recibió según qué pasó (pulsaron, rebotaron…). */
export function useCampaignRecipients(id: string | null, filter: CampaignRecipientFilter | null) {
  return useQuery({
    queryKey: [...campaignsKey, 'recipients', id, filter] as const,
    queryFn: () => apiFetch<CampaignRecipientDto[]>(`/campaigns/${id}/recipients?filter=${filter}`),
    enabled: !!id && !!filter,
  });
}

const automationsKey = [...campaignsKey, 'automations'] as const;

export function useCampaignAutomations(enabled = true) {
  return useQuery({
    queryKey: automationsKey,
    queryFn: () => apiFetch<CampaignAutomationDto[]>('/campaigns/automations'),
    enabled,
  });
}

export function useUpdateCampaignAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      kind,
      input,
    }: {
      kind: CampaignAutomationKind;
      input: UpdateCampaignAutomationInput;
    }) =>
      apiFetch<CampaignAutomationDto[]>(`/campaigns/automations/${kind}`, {
        method: 'PUT',
        json: input,
      }),
    onSuccess: (data) => qc.setQueryData(automationsKey, data),
  });
}

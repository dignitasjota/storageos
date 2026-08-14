'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CreateMarketingChannelInput,
  MarketingChannelDto,
  MarketingPerformanceDto,
  UpdateMarketingChannelInput,
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

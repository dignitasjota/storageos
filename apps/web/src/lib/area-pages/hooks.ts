'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AreaPagesSettingsDto,
  CreateAreaPageInput,
  UpdateAreaPageInput,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const key = ['area-pages'] as const;
const path = '/settings/web/area-pages';

export function useAreaPages() {
  return useQuery({ queryKey: key, queryFn: () => apiFetch<AreaPagesSettingsDto>(path) });
}

export function useSaveAreaPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id?: string; input: CreateAreaPageInput | UpdateAreaPageInput }) =>
      args.id
        ? apiFetch<AreaPagesSettingsDto>(`${path}/${args.id}`, {
            method: 'PATCH',
            json: args.input,
          })
        : apiFetch<AreaPagesSettingsDto>(path, { method: 'POST', json: args.input }),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

export function useDeleteAreaPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AreaPagesSettingsDto>(`${path}/${id}`, { method: 'DELETE' }),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

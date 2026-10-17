'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { UpdateWebLegalInput, WebLegalSettingsDto } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const key = ['settings', 'web-legal'] as const;

export function useWebLegal() {
  return useQuery({
    queryKey: key,
    queryFn: () => apiFetch<WebLegalSettingsDto>('/settings/tenant/web-legal'),
  });
}

export function useUpdateWebLegal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWebLegalInput) =>
      apiFetch<WebLegalSettingsDto>('/settings/tenant/web-legal', { method: 'PATCH', json: input }),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ContractTemplateDto, UpdateContractTemplateInput } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const templateKey = ['settings', 'tenant', 'contract-template'] as const;

export function useContractTemplate() {
  return useQuery({
    queryKey: templateKey,
    queryFn: () => apiFetch<ContractTemplateDto>('/settings/tenant/contract-template'),
  });
}

export function useUpdateContractTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateContractTemplateInput) =>
      apiFetch<ContractTemplateDto>('/settings/tenant/contract-template', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: templateKey }),
  });
}

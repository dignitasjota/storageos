'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { CreateRetentionOfferInput, RetentionOfferDto } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

export function useContractRetentionOffers(contractId: string, enabled = true) {
  return useQuery({
    queryKey: ['retention-offers', contractId] as const,
    queryFn: () => apiFetch<RetentionOfferDto[]>(`/contracts/${contractId}/retention-offers`),
    enabled,
    staleTime: 15_000,
  });
}

export function useCreateRetentionOffer(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRetentionOfferInput) =>
      apiFetch<RetentionOfferDto>(`/contracts/${contractId}/retention-offers`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['retention-offers', contractId] }),
  });
}

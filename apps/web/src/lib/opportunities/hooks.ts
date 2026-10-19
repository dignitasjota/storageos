import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  OpportunitiesDto,
  OpportunityDraftDto,
  OpportunityKind,
  ProposeOpportunityInput,
  ProposeOpportunityResultDto,
} from '@storageos/shared';

export function useOpportunities() {
  return useQuery({
    queryKey: ['opportunities'] as const,
    queryFn: () => apiFetch<OpportunitiesDto>('/opportunities'),
    staleTime: 60_000,
  });
}

export function useOpportunityDraft(customerId: string | null, kind: OpportunityKind | null) {
  return useQuery({
    queryKey: ['opportunities', 'draft', customerId, kind] as const,
    queryFn: () =>
      apiFetch<OpportunityDraftDto>(`/opportunities/draft?customerId=${customerId}&kind=${kind}`),
    enabled: !!customerId && !!kind,
  });
}

export function useProposeOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: Partial<ProposeOpportunityInput> &
        Pick<ProposeOpportunityInput, 'customerId' | 'kind'>,
    ) =>
      apiFetch<ProposeOpportunityResultDto>('/opportunities/propose', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['opportunities'] });
      void qc.invalidateQueries({ queryKey: ['communications'] });
      void qc.invalidateQueries({ queryKey: ['followups'] });
    },
  });
}

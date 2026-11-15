import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  DismissOpportunityInput,
  OpportunitiesDto,
  OpportunityDismissalDto,
  OpportunityDraftDto,
  OpportunityInterestedCountDto,
  OpportunityKind,
  OpportunityResultsDto,
  ProposeBulkInput,
  ProposeBulkResultDto,
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

export function useProposeBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProposeBulkInput) =>
      apiFetch<ProposeBulkResultDto>('/opportunities/propose-bulk', {
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

export function useDismissOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DismissOpportunityInput) =>
      apiFetch<void>('/opportunities/dismiss', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['opportunities'] }),
  });
}

export function useUndismissOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { customerId: string; kind: OpportunityKind }) =>
      apiFetch<void>(`/opportunities/dismiss?customerId=${args.customerId}&kind=${args.kind}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['opportunities'] }),
  });
}

export function useDismissedOpportunities(enabled: boolean) {
  return useQuery({
    queryKey: ['opportunities', 'dismissed'] as const,
    queryFn: () => apiFetch<OpportunityDismissalDto[]>('/opportunities/dismissed'),
    enabled,
  });
}

export function useOpportunityResults(days: number, enabled: boolean) {
  return useQuery({
    queryKey: ['opportunities', 'results', days] as const,
    queryFn: () => apiFetch<OpportunityResultsDto>(`/opportunities/results?days=${days}`),
    enabled,
  });
}

/** Inquilinos que han dicho «me interesa» (número del menú). */
export function useOpportunityInterestedCount(enabled = true) {
  return useQuery({
    queryKey: ['opportunities', 'interested-count'] as const,
    queryFn: () => apiFetch<OpportunityInterestedCountDto>('/opportunities/interested-count'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}

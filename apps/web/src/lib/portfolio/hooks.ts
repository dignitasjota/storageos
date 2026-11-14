import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  ContractAnnexSentDto,
  PriceChangeRowDto,
  PriceHistoryDto,
  RenewalOfferInput,
  RenewalRowDto,
  RenewalWindow,
  SetRentIncreaseExemptionInput,
} from '@storageos/shared';

const key = ['portfolio'] as const;

function qs(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function usePriceChanges(facilityId?: string) {
  return useQuery({
    queryKey: [...key, 'price-changes', facilityId ?? 'all'] as const,
    queryFn: () => apiFetch<PriceChangeRowDto[]>(`/portfolio/price-changes${qs({ facilityId })}`),
  });
}

export function useRenewalsInbox(window: RenewalWindow, facilityId?: string) {
  return useQuery({
    queryKey: [...key, 'renewals', window, facilityId ?? 'all'] as const,
    queryFn: () => apiFetch<RenewalRowDto[]>(`/portfolio/renewals${qs({ window, facilityId })}`),
  });
}

export function usePriceHistory(contractId: string | undefined) {
  return useQuery({
    queryKey: [...key, 'price-history', contractId] as const,
    queryFn: () => apiFetch<PriceHistoryDto>(`/contracts/${contractId}/price-history`),
    enabled: !!contractId,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['contracts'] });
    void qc.invalidateQueries({ queryKey: ['contract-anniversaries'] });
    void qc.invalidateQueries({ queryKey: ['rent-increases'] });
  };
}

export function useSendRenewalOffer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { contractId: string; input: RenewalOfferInput }) =>
      apiFetch<ContractAnnexSentDto>(`/contracts/${args.contractId}/renewal-offer`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: invalidate,
  });
}

export function useSetRentIncreaseExemption() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { contractId: string; input: SetRentIncreaseExemptionInput }) =>
      apiFetch<void>(`/contracts/${args.contractId}/rent-increase-exemption`, {
        method: 'PUT',
        json: args.input,
      }),
    onSuccess: invalidate,
  });
}

export function useSetAnniversaryPct() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { contractId: string; pct: number | null }) =>
      apiFetch<void>(`/contracts/${args.contractId}/anniversary-pct`, {
        method: 'PUT',
        json: { pct: args.pct },
      }),
    onSuccess: invalidate,
  });
}

import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { ContractDto } from '@storageos/shared';

/** Contratos que vencen pronto (renovación). */
export function useRenewals() {
  return useQuery({
    queryKey: ['contracts', 'renewals'] as const,
    queryFn: () => apiFetch<ContractDto[]>('/contracts/renewals'),
  });
}

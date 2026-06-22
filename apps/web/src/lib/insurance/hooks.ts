import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateInsurancePlanInput,
  InsurancePlanDto,
  UpdateInsurancePlanInput,
} from '@storageos/shared';

const key = ['insurance-plans'] as const;

export function useInsurancePlans(onlyActive = false) {
  return useQuery({
    queryKey: [...key, { onlyActive }] as const,
    queryFn: () =>
      apiFetch<InsurancePlanDto[]>(`/insurance-plans${onlyActive ? '?onlyActive=true' : ''}`),
  });
}

export function useCreateInsurancePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInsurancePlanInput) =>
      apiFetch<InsurancePlanDto>('/insurance-plans', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useUpdateInsurancePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateInsurancePlanInput }) =>
      apiFetch<InsurancePlanDto>(`/insurance-plans/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDeleteInsurancePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/insurance-plans/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

/** Asigna (planId) o quita (null) el seguro de un contrato. */
export function useSetContractInsurance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contractId, planId }: { contractId: string; planId: string | null }) =>
      apiFetch(`/contracts/${contractId}/insurance`, { method: 'PUT', json: { planId } }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['contracts'] });
      qc.invalidateQueries({ queryKey: ['contracts', vars.contractId] });
    },
  });
}

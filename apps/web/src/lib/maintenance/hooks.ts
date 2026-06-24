import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateMaintenancePlanInput,
  MaintenancePlanDto,
  UpdateMaintenancePlanInput,
} from '@storageos/shared';

const key = ['maintenance-plans'] as const;

export function useMaintenancePlans() {
  return useQuery({
    queryKey: key,
    queryFn: () => apiFetch<MaintenancePlanDto[]>('/maintenance-plans'),
  });
}

export function useCreateMaintenancePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMaintenancePlanInput) =>
      apiFetch<MaintenancePlanDto>('/maintenance-plans', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useUpdateMaintenancePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMaintenancePlanInput }) =>
      apiFetch<MaintenancePlanDto>(`/maintenance-plans/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useRunMaintenancePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ generated: boolean }>(`/maintenance-plans/${id}/run`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useDeleteMaintenancePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/maintenance-plans/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

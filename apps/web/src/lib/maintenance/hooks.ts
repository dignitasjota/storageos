import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { useHeaderFacilityId } from '../facilities/store';

import type {
  CreateMaintenancePlanInput,
  MaintenanceHistoryDto,
  MaintenancePlanDto,
  UpdateMaintenancePlanInput,
} from '@storageos/shared';

const key = ['maintenance-plans'] as const;

export function useMaintenancePlans() {
  const facilityId = useHeaderFacilityId();
  return useQuery({
    queryKey: [...key, facilityId ?? 'all'],
    queryFn: () =>
      apiFetch<MaintenancePlanDto[]>(
        `/maintenance-plans${facilityId ? `?facilityId=${facilityId}` : ''}`,
      ),
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
      apiFetch<{ generated: boolean; dueDate: string | null; reason?: 'open_task' }>(
        `/maintenance-plans/${id}/run`,
        { method: 'POST' },
      ),
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

/** Las tareas que ha creado un plan y si se hicieron a tiempo. */
export function useMaintenanceHistory(id: string | null) {
  return useQuery({
    queryKey: [...key, 'history', id],
    queryFn: () => apiFetch<MaintenanceHistoryDto>(`/maintenance-plans/${id}/history`),
    enabled: !!id,
  });
}

/** Copia un plan a otros locales. */
export function useCopyMaintenancePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; facilityIds: string[] }) =>
      apiFetch<MaintenancePlanDto[]>(`/maintenance-plans/${args.id}/copy`, {
        method: 'POST',
        json: { facilityIds: args.facilityIds },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

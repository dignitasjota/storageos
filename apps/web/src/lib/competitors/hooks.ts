import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CompetitorFacilityDto,
  CompetitorUnitDto,
  CreateCompetitorFacilityInput,
  CreateCompetitorUnitInput,
  UpdateCompetitorFacilityInput,
  UpdateCompetitorUnitInput,
} from '@storageos/shared';

const facilitiesKey = ['competitors'] as const;
const unitsKey = (id: string) => ['competitors', id, 'units'] as const;

export function useCompetitorFacilities() {
  return useQuery({
    queryKey: facilitiesKey,
    queryFn: () => apiFetch<CompetitorFacilityDto[]>('/competitors'),
  });
}

export function useCreateCompetitorFacility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCompetitorFacilityInput) =>
      apiFetch<CompetitorFacilityDto>('/competitors', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: facilitiesKey }),
  });
}

export function useUpdateCompetitorFacility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateCompetitorFacilityInput }) =>
      apiFetch<CompetitorFacilityDto>(`/competitors/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: facilitiesKey }),
  });
}

export function useDeleteCompetitorFacility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/competitors/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: facilitiesKey }),
  });
}

export function useCompetitorUnits(facilityId: string | null) {
  return useQuery({
    queryKey: facilityId ? unitsKey(facilityId) : ['competitors', 'none', 'units'],
    queryFn: () => apiFetch<CompetitorUnitDto[]>(`/competitors/${facilityId}/units`),
    enabled: Boolean(facilityId),
  });
}

export function useCreateCompetitorUnit(facilityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCompetitorUnitInput) =>
      apiFetch<CompetitorUnitDto>(`/competitors/${facilityId}/units`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: unitsKey(facilityId) });
      void qc.invalidateQueries({ queryKey: facilitiesKey });
    },
  });
}

export function useUpdateCompetitorUnit(facilityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { unitId: string; input: UpdateCompetitorUnitInput }) =>
      apiFetch<CompetitorUnitDto>(`/competitors/units/${args.unitId}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: unitsKey(facilityId) });
      void qc.invalidateQueries({ queryKey: facilitiesKey });
    },
  });
}

export function useDeleteCompetitorUnit(facilityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (unitId: string) =>
      apiFetch<void>(`/competitors/units/${unitId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: unitsKey(facilityId) });
      void qc.invalidateQueries({ queryKey: facilitiesKey });
    },
  });
}

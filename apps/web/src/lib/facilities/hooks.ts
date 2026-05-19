import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  ChangeUnitStatusInput,
  CreateFacilityInput,
  CreateFloorInput,
  CreateUnitInput,
  CreateUnitTypeInput,
  FacilityDto,
  FacilityFloorDto,
  OccupancyDashboardDto,
  PlanUploadResponseDto,
  RequestPlanUploadInput,
  UnitDto,
  UnitStatusHistoryDto,
  UnitTypeDto,
  UpdateFacilityInput,
  UpdateFloorInput,
  UpdateFloorPlanInput,
  UpdateUnitInput,
  UpdateUnitTypeInput,
  UpdateUnitsLayoutInput,
} from '@storageos/shared';

export const facilitiesKey = ['facilities'] as const;
export const facilityKey = (id: string) => ['facilities', id] as const;
export const unitTypesKey = ['unit-types'] as const;
export const unitsKey = (filters?: Record<string, string | undefined>) =>
  ['units', filters ?? {}] as const;
export const unitKey = (id: string) => ['units', id] as const;
export const unitHistoryKey = (id: string) => ['units', id, 'history'] as const;
export const floorsKey = (facilityId: string) => ['facilities', facilityId, 'floors'] as const;
export const dashboardOccupancyKey = ['dashboard', 'occupancy'] as const;

// ============================================================================
// Facilities
// ============================================================================

export function useFacilities() {
  return useQuery({
    queryKey: facilitiesKey,
    queryFn: () => apiFetch<FacilityDto[]>('/facilities'),
    staleTime: 30_000,
  });
}

export function useFacility(id: string | undefined) {
  return useQuery({
    queryKey: id ? facilityKey(id) : ['facility', 'none'],
    queryFn: () => apiFetch<FacilityDto>(`/facilities/${id}`),
    enabled: !!id,
  });
}

export function useCreateFacility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFacilityInput) =>
      apiFetch<FacilityDto>('/facilities', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: facilitiesKey });
    },
  });
}

export function useUpdateFacility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateFacilityInput }) =>
      apiFetch<FacilityDto>(`/facilities/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: facilitiesKey });
      void qc.invalidateQueries({ queryKey: facilityKey(data.id) });
    },
  });
}

export function useDeleteFacility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/facilities/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: facilitiesKey });
    },
  });
}

// ============================================================================
// Unit Types
// ============================================================================

export function useUnitTypes() {
  return useQuery({
    queryKey: unitTypesKey,
    queryFn: () => apiFetch<UnitTypeDto[]>('/unit-types'),
    staleTime: 30_000,
  });
}

export function useCreateUnitType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUnitTypeInput) =>
      apiFetch<UnitTypeDto>('/unit-types', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: unitTypesKey });
    },
  });
}

export function useUpdateUnitType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateUnitTypeInput }) =>
      apiFetch<UnitTypeDto>(`/unit-types/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: unitTypesKey });
    },
  });
}

export function useDeleteUnitType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/unit-types/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: unitTypesKey });
    },
  });
}

// ============================================================================
// Units
// ============================================================================

interface UnitFilters {
  facilityId?: string;
  floorId?: string;
  unitTypeId?: string;
  status?: string;
  search?: string;
}

export function useUnits(filters: UnitFilters = {}) {
  return useQuery({
    queryKey: unitsKey(filters as Record<string, string | undefined>),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) {
        if (v) params.set(k, v);
      }
      const qs = params.toString();
      return apiFetch<{ items: UnitDto[]; nextCursor: string | null }>(
        `/units${qs ? `?${qs}` : ''}`,
      );
    },
    staleTime: 15_000,
  });
}

export function useUnit(id: string | undefined) {
  return useQuery({
    queryKey: id ? unitKey(id) : ['unit', 'none'],
    queryFn: () => apiFetch<UnitDto>(`/units/${id}`),
    enabled: !!id,
  });
}

export function useUnitHistory(id: string | undefined) {
  return useQuery({
    queryKey: id ? unitHistoryKey(id) : ['unit', 'none', 'history'],
    queryFn: () => apiFetch<UnitStatusHistoryDto[]>(`/units/${id}/history`),
    enabled: !!id,
  });
}

export function useCreateUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUnitInput) =>
      apiFetch<UnitDto>('/units', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['units'] });
      void qc.invalidateQueries({ queryKey: dashboardOccupancyKey });
    },
  });
}

export function useUpdateUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateUnitInput }) =>
      apiFetch<UnitDto>(`/units/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['units'] });
    },
  });
}

export function useChangeUnitStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: ChangeUnitStatusInput }) =>
      apiFetch<UnitDto>(`/units/${args.id}/change-status`, { method: 'POST', json: args.input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['units'] });
      void qc.invalidateQueries({ queryKey: dashboardOccupancyKey });
    },
  });
}

export function useDeleteUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/units/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['units'] });
      void qc.invalidateQueries({ queryKey: dashboardOccupancyKey });
    },
  });
}

// ============================================================================
// Floors + plano
// ============================================================================

export function useFloors(facilityId: string | undefined) {
  return useQuery({
    queryKey: facilityId ? floorsKey(facilityId) : ['floors', 'none'],
    queryFn: () => apiFetch<FacilityFloorDto[]>(`/facilities/${facilityId}/floors`),
    enabled: !!facilityId,
  });
}

export function useCreateFloor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { facilityId: string; input: CreateFloorInput }) =>
      apiFetch<FacilityFloorDto>(`/facilities/${args.facilityId}/floors`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: floorsKey(data.facilityId) });
    },
  });
}

export function useUpdateFloor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateFloorInput }) =>
      apiFetch<FacilityFloorDto>(`/floors/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: floorsKey(data.facilityId) });
    },
  });
}

export function useDeleteFloor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/floors/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['floors'] });
    },
  });
}

export function useRequestPlanUploadUrl() {
  return useMutation({
    mutationFn: (args: { floorId: string; input: RequestPlanUploadInput }) =>
      apiFetch<PlanUploadResponseDto>(`/floors/${args.floorId}/plan-upload-url`, {
        method: 'POST',
        json: args.input,
      }),
  });
}

export function useSetFloorPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateFloorPlanInput }) =>
      apiFetch<FacilityFloorDto>(`/floors/${args.id}/plan`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: floorsKey(data.facilityId) });
    },
  });
}

export function useUpdateUnitsLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { floorId: string; input: UpdateUnitsLayoutInput }) =>
      apiFetch<{ updated: number }>(`/floors/${args.floorId}/units-layout`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['units'] });
    },
  });
}

// ============================================================================
// Dashboard
// ============================================================================

export function useOccupancyDashboard() {
  return useQuery({
    queryKey: dashboardOccupancyKey,
    queryFn: () => apiFetch<OccupancyDashboardDto>('/dashboard/occupancy'),
    staleTime: 60_000,
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CompetitorFacilityDto,
  CompetitorUnitDto,
  CompetitorUnitObservationDto,
  CreateCompetitorFacilityInput,
  ReviewCompetitorInput,
  CreateCompetitorUnitInput,
  MarketOccupancyDto,
  UpdateCompetitorFacilityInput,
  UpdateCompetitorUnitInput,
} from '@storageos/shared';

const facilitiesKey = ['competitors'] as const;
const unitsKey = (id: string) => ['competitors', id, 'units'] as const;

/**
 * Lo que cambia al tocar la competencia: sus fichas y trasteros, los avisos y
 * las sugerencias de precio que la usan.
 */
function invalidateMarket(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: facilitiesKey });
  for (const scope of [
    'competition-alerts',
    'pricing-suggestions',
    'unit-pricing-suggestions',
    'suggested-actions',
  ]) {
    void qc.invalidateQueries({ queryKey: ['analytics', scope] });
  }
}

const withFacility = (path: string, facilityId?: string | null) =>
  facilityId ? `${path}?facilityId=${facilityId}` : path;

export function useCompetitorFacilities(facilityId?: string | null) {
  return useQuery({
    queryKey: [...facilitiesKey, 'list', facilityId ?? null] as const,
    queryFn: () => apiFetch<CompetitorFacilityDto[]>(withFacility('/competitors', facilityId)),
  });
}

/** Ocupación de mercado: la mía vs la de la competencia. */
export function useMarketOccupancy(facilityId?: string | null) {
  return useQuery({
    queryKey: ['competitors', 'occupancy', facilityId ?? null] as const,
    queryFn: () => apiFetch<MarketOccupancyDto>(withFacility('/competitors/occupancy', facilityId)),
  });
}

export function useCreateCompetitorFacility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCompetitorFacilityInput) =>
      apiFetch<CompetitorFacilityDto>('/competitors', { method: 'POST', json: input }),
    onSuccess: () => invalidateMarket(qc),
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
    onSuccess: () => invalidateMarket(qc),
  });
}

export function useDeleteCompetitorFacility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/competitors/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateMarket(qc),
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
    onSuccess: () => invalidateMarket(qc),
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
      invalidateMarket(qc);
    },
  });
}

export function useDeleteCompetitorUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (unitId: string) =>
      apiFetch<void>(`/competitors/units/${unitId}`, { method: 'DELETE' }),
    onSuccess: () => invalidateMarket(qc),
  });
}

/** Revisión: precio y estado de hoy de todos sus trasteros. */
export function useReviewCompetitor(facilityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewCompetitorInput) =>
      apiFetch<CompetitorUnitDto[]>(`/competitors/${facilityId}/review`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => invalidateMarket(qc),
  });
}

/** Histórico de comprobaciones de un trastero de la competencia. */
export function useCompetitorUnitHistory(unitId: string | null) {
  return useQuery({
    queryKey: ['competitors', 'unit-history', unitId] as const,
    queryFn: () => apiFetch<CompetitorUnitObservationDto[]>(`/competitors/units/${unitId}/history`),
    enabled: !!unitId,
  });
}

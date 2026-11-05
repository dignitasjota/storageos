import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { useHeaderFacilityId } from '../facilities/store';

import type {
  HeldUnitDto,
  ReservationDto,
  ReservationSettingsDto,
  ReservationStatsDto,
  UnitAlternativeDto,
  UnitHoldDto,
  UnitInboxDto,
  UnitInboxKind,
  UnitRequestDto,
  UnitRequestToWaitlistInput,
  UpdateReservationInput,
  UpdateReservationSettingsInput,
} from '@storageos/shared';

function facilityQs(facilityId: string | undefined, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams({ ...extra, ...(facilityId ? { facilityId } : {}) }).toString();
  return qs ? `?${qs}` : '';
}

export function useHeldUnits() {
  const facilityId = useHeaderFacilityId();
  return useQuery({
    queryKey: ['reservations', 'held-units', facilityId ?? 'all'] as const,
    queryFn: () => apiFetch<HeldUnitDto[]>(`/reservations/held-units${facilityQs(facilityId)}`),
  });
}

export function useUnitHold(unitId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['units', unitId, 'hold'] as const,
    queryFn: () => apiFetch<{ hold: UnitHoldDto | null }>(`/units/${unitId}/hold`),
    enabled,
  });
}

export function useReservationSettings() {
  return useQuery({
    queryKey: ['reservations', 'settings'] as const,
    queryFn: () => apiFetch<ReservationSettingsDto>('/reservations/settings'),
  });
}

export function useUpdateReservationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateReservationSettingsInput) =>
      apiFetch<ReservationSettingsDto>('/reservations/settings', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reservations', 'settings'] }),
  });
}

export function useUpdateReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateReservationInput }) =>
      apiFetch<ReservationDto>(`/reservations/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reservations'] }),
  });
}

export function useReservationStats(days: number) {
  const facilityId = useHeaderFacilityId();
  return useQuery({
    queryKey: ['unit-inbox', 'stats', days, facilityId ?? 'all'] as const,
    queryFn: () =>
      apiFetch<ReservationStatsDto>(
        `/unit-inbox/stats${facilityQs(facilityId, { days: String(days) })}`,
      ),
  });
}

export function useUnitInbox() {
  const facilityId = useHeaderFacilityId();
  return useQuery({
    queryKey: ['unit-inbox', 'list', facilityId ?? 'all'] as const,
    queryFn: () => apiFetch<UnitInboxDto>(`/unit-inbox${facilityQs(facilityId)}`),
  });
}

export function useAssignUnitInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { kind: UnitInboxKind; id: string; userId: string | null }) =>
      apiFetch<void>(`/unit-inbox/${args.kind}/${args.id}/assign`, {
        method: 'PATCH',
        json: { userId: args.userId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['unit-inbox'] }),
  });
}

export function useUnitAlternatives(requestId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['unit-change-requests', requestId, 'alternatives'] as const,
    queryFn: () =>
      apiFetch<UnitAlternativeDto[]>(`/unit-change-requests/${requestId}/alternatives`),
    enabled,
  });
}

export function useUnitRequestToWaitlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UnitRequestToWaitlistInput }) =>
      apiFetch<UnitRequestDto>(`/unit-requests/${args.id}/to-waitlist`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['unit-requests'] });
      void qc.invalidateQueries({ queryKey: ['waitlist'] });
    },
  });
}

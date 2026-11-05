'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CreateWaitlistEntryInput,
  UpcomingUnitDto,
  UpdateWaitlistEntryInput,
  WaitlistDemandRowDto,
  WaitlistEntryDto,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

export function useWaitlist(filters: { status?: string; facilityId?: string } = {}) {
  return useQuery({
    queryKey: ['waitlist', filters] as const,
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      const qs = params.toString();
      return apiFetch<WaitlistEntryDto[]>(`/waitlist${qs ? `?${qs}` : ''}`);
    },
    staleTime: 15_000,
  });
}

export function useCreateWaitlistEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWaitlistEntryInput) =>
      apiFetch<WaitlistEntryDto>('/waitlist', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['waitlist'] }),
  });
}

export function useUpdateWaitlistEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateWaitlistEntryInput }) =>
      apiFetch<WaitlistEntryDto>(`/waitlist/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['waitlist'] }),
  });
}

export function useWaitlistDemand(facilityId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['waitlist', 'demand', facilityId ?? 'all'] as const,
    queryFn: () =>
      apiFetch<WaitlistDemandRowDto[]>(
        `/waitlist/demand${facilityId ? `?facilityId=${facilityId}` : ''}`,
      ),
    enabled,
  });
}

/** Gente con hueco libre y avisos sin respuesta — badge del menú (60 s). */
export function useWaitlistPendingCount(enabled = true) {
  return useQuery({
    queryKey: ['waitlist', 'pending-count'] as const,
    queryFn: () => apiFetch<{ count: number }>('/waitlist/pending-count'),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useUpcomingUnits(entryId: string | undefined) {
  return useQuery({
    queryKey: ['waitlist', entryId, 'upcoming-units'] as const,
    queryFn: () => apiFetch<UpcomingUnitDto[]>(`/waitlist/${entryId}/upcoming-units`),
    enabled: !!entryId,
  });
}

/** Avisar ahora, ceder el turno o volver a la cola. */
export function useWaitlistAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; action: 'notify' | 'skip' | 'requeue' }) =>
      apiFetch<WaitlistEntryDto>(`/waitlist/${args.id}/${args.action}`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['waitlist'] }),
  });
}

export function usePreassignWaitlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; unitId: string | null }) =>
      apiFetch<WaitlistEntryDto>(`/waitlist/${args.id}/preassign`, {
        method: 'POST',
        json: { unitId: args.unitId },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['waitlist'] }),
  });
}

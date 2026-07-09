'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CreateWaitlistEntryInput,
  UpdateWaitlistEntryInput,
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

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { CreateOwnerInput, OwnerDto, UpdateOwnerInput } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';
import { useHasFeature } from '@/lib/auth/hooks';

export const ownersKey = ['owners'] as const;

/** Propietarios del tenant (plan Administrador). Vacío sin la funcionalidad. */
export function useOwners() {
  const enabled = useHasFeature('multi_owner');
  return useQuery({
    queryKey: ownersKey,
    queryFn: () => apiFetch<OwnerDto[]>('/owners'),
    enabled,
  });
}

export function useCreateOwner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOwnerInput) =>
      apiFetch<OwnerDto>('/owners', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ownersKey }),
  });
}

export function useUpdateOwner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateOwnerInput }) =>
      apiFetch<OwnerDto>(`/owners/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ownersKey }),
  });
}

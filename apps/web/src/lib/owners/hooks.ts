'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { AeatCredentialMetadata } from '@/lib/billing/verifactu-hooks';
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

const ownerCertKey = (ownerId: string) => ['owners', ownerId, 'aeat-credential'] as const;

/** Certificado propio del propietario para Veri*Factu (null = usa el tuyo). */
export function useOwnerCertificate(ownerId: string, enabled = true) {
  return useQuery({
    queryKey: ownerCertKey(ownerId),
    queryFn: async () =>
      (
        await apiFetch<{ credential: AeatCredentialMetadata | null }>(
          `/owners/${ownerId}/aeat-credential`,
        )
      ).credential,
    enabled,
  });
}

export function useUploadOwnerCertificate(ownerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      file: File;
      password: string;
      environment: 'sandbox' | 'production';
    }) => {
      const fd = new FormData();
      fd.append('file', input.file);
      fd.append('password', input.password);
      fd.append('environment', input.environment);
      return apiFetch<AeatCredentialMetadata>(`/owners/${ownerId}/aeat-credential`, {
        method: 'POST',
        formData: fd,
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ownerCertKey(ownerId) }),
  });
}

export function useRemoveOwnerCertificate(ownerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>(`/owners/${ownerId}/aeat-credential`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ownerCertKey(ownerId) }),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { PendingLegalVersionDto, PlatformBannerDto } from '@storageos/shared';

/** Banner global de plataforma (lo lee el panel del tenant). */
export function usePlatformBanner() {
  return useQuery({
    queryKey: ['platform-banner'] as const,
    // Sin banner activo el API responde sin cuerpo (Nest no serializa un `null`
    // a pelo) y React Query no admite `undefined` como dato.
    queryFn: async () =>
      (await apiFetch<PlatformBannerDto | null | undefined>('/platform-banner')) ?? null,
    // Un aviso urgente debe verse pronto: se mira cada minuto y al volver a la pestaña.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

/** Textos legales de TrasterOS que el negocio tiene que aceptar. */
export function usePendingLegal() {
  return useQuery({
    queryKey: ['platform-legal-pending'] as const,
    queryFn: () => apiFetch<PendingLegalVersionDto[]>('/platform-legal-pending'),
    staleTime: 5 * 60_000,
  });
}

export function useAcceptLegal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      apiFetch<null>(`/platform-legal-pending/${versionId}/accept`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['platform-legal-pending'] }),
  });
}

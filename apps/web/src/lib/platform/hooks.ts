import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { PlatformBannerDto } from '@storageos/shared';

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

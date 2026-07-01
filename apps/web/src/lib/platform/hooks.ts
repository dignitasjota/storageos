import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { PlatformBannerDto } from '@storageos/shared';

/** Banner global de plataforma (lo lee el panel del tenant). */
export function usePlatformBanner() {
  return useQuery({
    queryKey: ['platform-banner'] as const,
    queryFn: () => apiFetch<PlatformBannerDto | null>('/platform-banner'),
    staleTime: 5 * 60_000,
  });
}

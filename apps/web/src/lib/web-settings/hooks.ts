import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { compressImage } from '../images/compress';

import type {
  UpdateWebSettingsInput,
  WebHeroSlot,
  WebHeroUploadDto,
  WebPerformanceDto,
  WebSettingsResponse,
} from '@storageos/shared';

const key = ['settings', 'web'] as const;

export function useWebSettings() {
  return useQuery({
    queryKey: key,
    queryFn: () => apiFetch<WebSettingsResponse>('/settings/tenant/web'),
  });
}

export function useUpdateWebSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWebSettingsInput) =>
      apiFetch<WebSettingsResponse>('/settings/tenant/web', { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

/**
 * Sube una foto de la portada (entrada o fondo): se comprime en el navegador,
 * se sube por URL firmada al bucket público y se fija su clave.
 */
export function useUploadWebHeroImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ slot, file }: { slot: WebHeroSlot; file: File }) => {
      const compressed = await compressImage(file);
      const mimeType =
        compressed.type === 'image/png' || compressed.type === 'image/webp'
          ? compressed.type
          : 'image/jpeg';
      const up = await apiFetch<WebHeroUploadDto>('/settings/tenant/web/hero-image-upload-url', {
        method: 'POST',
        json: { slot, mimeType },
      });
      const put = await fetch(up.uploadUrl, {
        method: 'PUT',
        headers: up.requiredHeaders,
        body: compressed,
      });
      if (!put.ok) throw new Error('upload_failed');
      return apiFetch<WebSettingsResponse>('/settings/tenant/web/hero-image', {
        method: 'PUT',
        json: { slot, key: up.key },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useRemoveWebHeroImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slot: WebHeroSlot) =>
      apiFetch<WebSettingsResponse>('/settings/tenant/web/hero-image', {
        method: 'PUT',
        json: { slot, key: null },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

/** Rendimiento de la web: leads → contrato → MRR (últimos 90 días). */
export function useWebPerformance() {
  return useQuery({
    queryKey: ['analytics', 'web-performance'] as const,
    queryFn: () => apiFetch<WebPerformanceDto>('/analytics/web-performance'),
  });
}

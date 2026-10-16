'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  BlogCoverUploadResponseDto,
  CreatePromoLandingInput,
  PromoLandingDto,
  PromoLandingStatsDto,
  UpdatePromoLandingInput,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const key = ['promo-landings'] as const;

export function usePromoLandings() {
  return useQuery({
    queryKey: key,
    queryFn: () => apiFetch<PromoLandingDto[]>('/promo-landings'),
  });
}

export function useCreatePromoLanding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePromoLandingInput) =>
      apiFetch<PromoLandingDto>('/promo-landings', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useUpdatePromoLanding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdatePromoLandingInput }) =>
      apiFetch<PromoLandingDto>(`/promo-landings/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDuplicatePromoLanding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PromoLandingDto>(`/promo-landings/${id}/duplicate`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDeletePromoLanding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/promo-landings/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useInvalidatePromoLandings() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: key });
}

/** Sube la foto principal por URL firmada y la confirma (`null` la quita). */
export async function uploadPromoLandingImage(id: string, file: File): Promise<PromoLandingDto> {
  const presign = await apiFetch<BlogCoverUploadResponseDto>(
    `/promo-landings/${id}/image/upload-url`,
    { method: 'POST', json: { mimeType: file.type, sizeBytes: file.size } },
  );
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: presign.requiredHeaders,
    body: file,
  });
  if (!put.ok) throw new Error('No se pudo subir la imagen');
  return apiFetch<PromoLandingDto>(`/promo-landings/${id}/image`, {
    method: 'PUT',
    json: { heroImageKey: presign.key },
  });
}

export function removePromoLandingImage(id: string): Promise<PromoLandingDto> {
  return apiFetch<PromoLandingDto>(`/promo-landings/${id}/image`, {
    method: 'PUT',
    json: { heroImageKey: null },
  });
}

export function usePromoLandingStats(id: string | null, days: number) {
  return useQuery({
    queryKey: ['promo-landings', id, 'stats', days],
    queryFn: () => apiFetch<PromoLandingStatsDto>(`/promo-landings/${id}/stats?days=${days}`),
    enabled: id != null,
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  RequestReviewInput,
  RequestReviewResultDto,
  ReviewDto,
  ReviewListDto,
  ReviewStatsDto,
  TenantReviewsSettingsResponse,
  UpdateTenantReviewsSettingsInput,
} from '@storageos/shared';

const reviewsKey = ['reviews'] as const;
const reviewStatsKey = ['reviews', 'stats'] as const;
const reviewsSettingsKey = ['settings', 'reviews'] as const;

export function useReviews(status?: string) {
  return useQuery({
    queryKey: [...reviewsKey, status ?? 'all'] as const,
    queryFn: () => apiFetch<ReviewListDto>(`/reviews${status ? `?status=${status}` : ''}`),
  });
}

/** Publica o retira una valoración como testimonio en la web pública. */
export function usePublishReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; published: boolean }) =>
      apiFetch<ReviewDto>(`/reviews/${args.id}/web`, {
        method: 'PATCH',
        json: { published: args.published },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: reviewsKey }),
  });
}

/** Pide al autor de una valoración publicada que la deje en Google. */
export function useRequestGoogleReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ReviewDto>(`/reviews/${id}/google-request`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: reviewsKey }),
  });
}

export function useReviewStats() {
  return useQuery({
    queryKey: reviewStatsKey,
    queryFn: () => apiFetch<ReviewStatsDto>('/reviews/stats'),
  });
}

export function useRequestReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RequestReviewInput) =>
      apiFetch<RequestReviewResultDto>('/reviews/request', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: reviewsKey });
    },
  });
}

export function useReviewsSettings() {
  return useQuery({
    queryKey: reviewsSettingsKey,
    queryFn: () => apiFetch<TenantReviewsSettingsResponse>('/settings/tenant/reviews'),
  });
}

export function useUpdateReviewsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantReviewsSettingsInput) =>
      apiFetch<TenantReviewsSettingsResponse>('/settings/tenant/reviews', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: reviewsSettingsKey }),
  });
}

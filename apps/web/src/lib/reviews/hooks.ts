import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  RequestReviewInput,
  RequestReviewResultDto,
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

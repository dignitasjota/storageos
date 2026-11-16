import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  RequestReviewInput,
  RequestReviewResultDto,
  ReviewDto,
  ReviewInsightsDto,
  ReviewListDto,
  ReviewStatsDto,
  TenantReviewsSettingsResponse,
  UpdateTenantReviewsSettingsInput,
} from '@storageos/shared';

const reviewsKey = ['reviews'] as const;
const reviewStatsKey = ['reviews', 'stats'] as const;
const reviewsSettingsKey = ['settings', 'reviews'] as const;

/** Historial por páginas («Cargar más»), con filtro de estado opcional. */
export function useReviews(status?: string) {
  return useInfiniteQuery({
    queryKey: [...reviewsKey, 'list', status ?? 'all'] as const,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (pageParam) qs.set('cursor', pageParam);
      const query = qs.toString();
      return apiFetch<ReviewListDto>(`/reviews${query ? `?${query}` : ''}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Vuelve a enviar una valoración sin responder (enlace nuevo de 30 días). */
export function useResendReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<ReviewDto>(`/reviews/${id}/resend`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: reviewsKey }),
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

/** Periodo (meses hacia atrás; sin valor, todo) y local de las cifras. */
export interface ReviewPeriod {
  months?: number | undefined;
  facilityId?: string | undefined;
}

function periodQuery(p: ReviewPeriod): string {
  const qs = new URLSearchParams();
  if (p.months) qs.set('months', String(p.months));
  if (p.facilityId) qs.set('facilityId', p.facilityId);
  const query = qs.toString();
  return query ? `?${query}` : '';
}

export function useReviewStats(period: ReviewPeriod = {}) {
  return useQuery({
    queryKey: [...reviewStatsKey, period.months ?? 'all', period.facilityId ?? 'all'] as const,
    queryFn: () => apiFetch<ReviewStatsDto>(`/reviews/stats${periodQuery(period)}`),
  });
}

/** NPS mes a mes y por local. */
export function useReviewInsights(period: ReviewPeriod = {}) {
  return useQuery({
    queryKey: [
      ...reviewsKey,
      'insights',
      period.months ?? 'all',
      period.facilityId ?? 'all',
    ] as const,
    queryFn: () => apiFetch<ReviewInsightsDto>(`/reviews/insights${periodQuery(period)}`),
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

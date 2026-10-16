import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CouponDto,
  CouponQuoteDto,
  CouponRedemptionDto,
  CreateCouponInput,
  UpdateCouponInput,
  ValidateCouponInput,
} from '@storageos/shared';

const couponsKey = ['coupons'] as const;

export function useCoupons() {
  return useQuery({
    queryKey: couponsKey,
    queryFn: () => apiFetch<CouponDto[]>('/coupons'),
  });
}

export function useCouponRedemptions(id: string | null) {
  return useQuery({
    queryKey: [...couponsKey, id, 'redemptions'],
    queryFn: () => apiFetch<CouponRedemptionDto[]>(`/coupons/${id}/redemptions`),
    enabled: !!id,
  });
}

export function useCreateCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCouponInput) =>
      apiFetch<CouponDto>('/coupons', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: couponsKey }),
  });
}

export function useUpdateCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateCouponInput }) =>
      apiFetch<CouponDto>(`/coupons/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: couponsKey }),
  });
}

export function useDeleteCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/coupons/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: couponsKey }),
  });
}

/** Comprueba un cupón para un trastero y unos meses (alta de contrato). */
export function useValidateCoupon() {
  return useMutation({
    mutationFn: (input: ValidateCouponInput) =>
      apiFetch<CouponQuoteDto>('/coupons/validate', { method: 'POST', json: input }),
  });
}

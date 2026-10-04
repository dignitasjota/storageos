import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreatePromotionInput,
  CreateUnitOfferInput,
  UnitOfferDto,
  PromotionDto,
  UpdatePromotionInput,
  ValidatePromotionInput,
  ValidatePromotionResultDto,
} from '@storageos/shared';

const promotionsKey = ['promotions'] as const;

export function usePromotions() {
  return useQuery({
    queryKey: promotionsKey,
    queryFn: () => apiFetch<PromotionDto[]>('/promotions'),
  });
}

export function useCreatePromotion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePromotionInput) =>
      apiFetch<PromotionDto>('/promotions', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: promotionsKey }),
  });
}

export function useUpdatePromotion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdatePromotionInput }) =>
      apiFetch<PromotionDto>(`/promotions/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: promotionsKey }),
  });
}

export function useDeletePromotion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/promotions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: promotionsKey }),
  });
}

/** Valida/previsualiza un código promocional contra un precio mensual. */
export function useValidatePromotion() {
  return useMutation({
    mutationFn: (input: ValidatePromotionInput) =>
      apiFetch<ValidatePromotionResultDto>('/promotions/validate', { method: 'POST', json: input }),
  });
}

/** Ofertas activas de trasteros concretos (`unitId` para uno). */
export function useUnitOffers(unitId?: string | null, enabled = true) {
  return useQuery({
    queryKey: [...promotionsKey, 'unit-offers', unitId ?? 'all'] as const,
    queryFn: () =>
      apiFetch<UnitOfferDto[]>(`/promotions/unit-offers${unitId ? `?unitId=${unitId}` : ''}`),
    enabled,
  });
}

/** Crea a mano una oferta para un trastero concreto. */
export function useCreateUnitOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUnitOfferInput) =>
      apiFetch<UnitOfferDto>('/promotions/unit-offers', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: promotionsKey });
      void qc.invalidateQueries({ queryKey: ['analytics', 'unit-pricing-suggestions'] });
    },
  });
}

export function useCancelUnitOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (unitId: string) =>
      apiFetch<void>(`/promotions/unit-offers/${unitId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: promotionsKey });
      void qc.invalidateQueries({ queryKey: ['analytics', 'unit-pricing-suggestions'] });
    },
  });
}

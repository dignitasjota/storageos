import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreatePromotionInput,
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

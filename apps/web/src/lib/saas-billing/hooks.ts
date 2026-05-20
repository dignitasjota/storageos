import { useMutation, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  BillingSessionResponseDto,
  CreateCheckoutSessionInput,
  CreatePortalSessionInput,
  SubscriptionPlanDto,
  TenantSubscriptionDto,
} from '@storageos/shared';

/**
 * Hooks de la suscripcion SaaS del tenant (NO del facturado a inquilinos).
 * Usados por `/settings/saas-billing`.
 */

export const saasSubscriptionKey = ['saas-billing', 'subscription'] as const;
export const subscriptionPlansKey = ['saas-billing', 'plans'] as const;

export function useSaasSubscription() {
  return useQuery({
    queryKey: saasSubscriptionKey,
    queryFn: () => apiFetch<TenantSubscriptionDto>('/settings/saas-billing'),
  });
}

export function useSubscriptionPlans() {
  return useQuery({
    queryKey: subscriptionPlansKey,
    // Endpoint publico: no requiere auth, pero apiFetch lo enviara si hay token.
    queryFn: () => apiFetch<SubscriptionPlanDto[]>('/subscription-plans', { requiresAuth: false }),
  });
}

export function useCreateCheckoutSession() {
  return useMutation({
    mutationFn: (input: CreateCheckoutSessionInput) =>
      apiFetch<BillingSessionResponseDto>('/settings/saas-billing/checkout', {
        method: 'POST',
        json: input,
      }),
  });
}

export function useCreatePortalSession() {
  return useMutation({
    mutationFn: (input: CreatePortalSessionInput) =>
      apiFetch<BillingSessionResponseDto>('/settings/saas-billing/portal', {
        method: 'POST',
        json: input,
      }),
  });
}

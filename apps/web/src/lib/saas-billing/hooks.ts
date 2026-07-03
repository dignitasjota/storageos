import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  BillingSessionResponseDto,
  CreateCheckoutSessionInput,
  CreatePortalSessionInput,
  SelfAssignAddonInput,
  SubscriptionPlanDto,
  TenantSelfAddonsDto,
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

// --- Add-ons self-service del tenant ---
export function useSelfAddons() {
  return useQuery({
    queryKey: ['saas-billing', 'addons'] as const,
    queryFn: () => apiFetch<TenantSelfAddonsDto>('/settings/saas-billing/addons'),
  });
}

export function useContractAddon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SelfAssignAddonInput) =>
      apiFetch<TenantSelfAddonsDto>('/settings/saas-billing/addons', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['saas-billing', 'addons'] });
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] }); // features pueden cambiar
    },
  });
}

export function useCancelAddon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) =>
      apiFetch<TenantSelfAddonsDto>(`/settings/saas-billing/addons/${assignmentId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['saas-billing', 'addons'] });
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });
}

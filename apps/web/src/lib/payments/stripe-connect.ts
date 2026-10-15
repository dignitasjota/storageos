import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { CardProvider, StripeConnectLinkDto, StripeConnectStatusDto } from '@storageos/shared';

const key = ['stripe-connect'] as const;

export function useStripeConnect() {
  return useQuery({
    queryKey: key,
    queryFn: () => apiFetch<StripeConnectStatusDto>('/settings/stripe-connect'),
  });
}

function useStatusMutation<V = void>(fn: (v: V) => Promise<StripeConnectStatusDto>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

export function useStripeConnectOnboarding() {
  return useMutation({
    mutationFn: () =>
      apiFetch<StripeConnectLinkDto>('/settings/stripe-connect/onboarding-link', {
        method: 'POST',
      }),
  });
}

export function useStripeConnectDashboard() {
  return useMutation({
    mutationFn: () =>
      apiFetch<StripeConnectLinkDto>('/settings/stripe-connect/dashboard-link', {
        method: 'POST',
      }),
  });
}

export function useRefreshStripeConnect() {
  return useStatusMutation(() =>
    apiFetch<StripeConnectStatusDto>('/settings/stripe-connect/refresh', { method: 'POST' }),
  );
}

export function useDisconnectStripe() {
  return useStatusMutation(() =>
    apiFetch<StripeConnectStatusDto>('/settings/stripe-connect', { method: 'DELETE' }),
  );
}

export function useSetCardProvider() {
  return useStatusMutation((provider: CardProvider | null) =>
    apiFetch<StripeConnectStatusDto>('/settings/stripe-connect/card-provider', {
      method: 'PUT',
      json: { provider },
    }),
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { meQueryKey } from '../auth/hooks';
import { useAuthStore } from '../auth/store';

import type {
  AuthSuccessResponse,
  Challenge2faInput,
  Disable2faInput,
  Enrol2faRequiredSetupInput,
  Enrol2faRequiredVerifyInput,
  RecoveryCodesResponse,
  Regenerate2faRecoveryCodesInput,
  Setup2faResponse,
  TwoFactorStatusResponse,
  Verify2faSetupInput,
} from '@storageos/shared';

export const twoFactorStatusKey = ['auth', '2fa', 'status'] as const;

export function useTwoFactorStatus(enabled = true) {
  return useQuery({
    queryKey: twoFactorStatusKey,
    queryFn: () => apiFetch<TwoFactorStatusResponse>('/auth/2fa/status'),
    enabled,
    staleTime: 0,
  });
}

export function useSetup2fa() {
  return useMutation({
    mutationFn: () => apiFetch<Setup2faResponse>('/auth/2fa/setup', { method: 'POST' }),
  });
}

export function useVerify2faSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Verify2faSetupInput) =>
      apiFetch<RecoveryCodesResponse>('/auth/2fa/verify', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: twoFactorStatusKey });
      void qc.invalidateQueries({ queryKey: meQueryKey });
    },
  });
}

export function useDisable2fa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Disable2faInput) =>
      apiFetch<void>('/auth/2fa/disable', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: twoFactorStatusKey });
      void qc.invalidateQueries({ queryKey: meQueryKey });
    },
  });
}

export function useRegenerate2faRecoveryCodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Regenerate2faRecoveryCodesInput) =>
      apiFetch<RecoveryCodesResponse>('/auth/2fa/recovery-codes/regenerate', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: twoFactorStatusKey });
    },
  });
}

export function useChallenge2fa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Challenge2faInput) =>
      apiFetch<AuthSuccessResponse>('/auth/2fa/challenge', {
        method: 'POST',
        json: input,
        requiresAuth: false,
      }),
    onSuccess: (data) => {
      useAuthStore.getState().setAccessToken(data.accessToken);
      qc.setQueryData(meQueryKey, {
        user: data.user,
        tenant: data.tenant,
        subscription: data.subscription,
      });
    },
  });
}

// ============================================================================
// Enrolment forzoso (politica `requireTwoFactorForManagers`)
// ============================================================================

export function useEnrol2faRequiredSetup() {
  return useMutation({
    mutationFn: (input: Enrol2faRequiredSetupInput) =>
      apiFetch<Setup2faResponse>('/auth/2fa/enrol-required/setup', {
        method: 'POST',
        json: input,
        requiresAuth: false,
      }),
  });
}

export function useEnrol2faRequiredVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Enrol2faRequiredVerifyInput) =>
      apiFetch<AuthSuccessResponse & { recoveryCodes: string[] }>(
        '/auth/2fa/enrol-required/verify',
        {
          method: 'POST',
          json: input,
          requiresAuth: false,
        },
      ),
    onSuccess: (data) => {
      useAuthStore.getState().setAccessToken(data.accessToken);
      qc.setQueryData(meQueryKey, {
        user: data.user,
        tenant: data.tenant,
        subscription: data.subscription,
      });
    },
  });
}

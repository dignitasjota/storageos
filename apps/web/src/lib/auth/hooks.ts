import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from './api';
import { useAuthStore } from './store';

import type {
  AuthSuccessResponse,
  ForgotPasswordInput,
  LoginInput,
  MeResponse,
  RegisterInput,
  RegisterPendingResponse,
  ResendVerificationInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from '@storageos/shared';

export const meQueryKey = ['auth', 'me'] as const;

/** Carga del perfil del usuario autenticado. */
export function useMe(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: () => apiFetch<MeResponse>('/auth/me'),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
  });
}

/** POST /auth/login con email/password/tenantSlug. */
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) =>
      apiFetch<AuthSuccessResponse>('/auth/login', {
        method: 'POST',
        json: input,
        requiresAuth: false,
      }),
    onSuccess: (data) => {
      useAuthStore.getState().setAccessToken(data.accessToken);
      queryClient.setQueryData(meQueryKey, {
        user: data.user,
        tenant: data.tenant,
        subscription: data.subscription,
      });
    },
  });
}

/**
 * POST /auth/register. NO emite tokens: el frontend debe redirigir al
 * usuario a la pantalla "te hemos enviado un email".
 */
export function useRegister() {
  return useMutation({
    mutationFn: (input: RegisterInput) =>
      apiFetch<RegisterPendingResponse>('/auth/register', {
        method: 'POST',
        json: input,
        requiresAuth: false,
      }),
  });
}

/** POST /auth/verify-email. Devuelve tokens y arranca sesion. */
export function useVerifyEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: VerifyEmailInput) =>
      apiFetch<AuthSuccessResponse>('/auth/verify-email', {
        method: 'POST',
        json: input,
        requiresAuth: false,
      }),
    onSuccess: (data) => {
      useAuthStore.getState().setAccessToken(data.accessToken);
      queryClient.setQueryData(meQueryKey, {
        user: data.user,
        tenant: data.tenant,
        subscription: data.subscription,
      });
    },
  });
}

export function useResendVerification() {
  return useMutation({
    mutationFn: (input: ResendVerificationInput) =>
      apiFetch<void>('/auth/resend-verification', {
        method: 'POST',
        json: input,
        requiresAuth: false,
      }),
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (input: ForgotPasswordInput) =>
      apiFetch<void>('/auth/password/forgot', {
        method: 'POST',
        json: input,
        requiresAuth: false,
      }),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (input: ResetPasswordInput) =>
      apiFetch<void>('/auth/password/reset', {
        method: 'POST',
        json: input,
        requiresAuth: false,
      }),
  });
}

/** POST /auth/logout. */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await apiFetch<void>('/auth/logout', { method: 'POST' });
      } catch {
        // ignore
      }
    },
    onSettled: () => {
      useAuthStore.getState().clear();
      queryClient.removeQueries({ queryKey: meQueryKey });
    },
  });
}

/** POST /auth/logout-all. */
export function useLogoutAll() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ revokedCount: number }>('/auth/logout-all', { method: 'POST' }),
    onSettled: () => {
      useAuthStore.getState().clear();
      queryClient.removeQueries({ queryKey: meQueryKey });
    },
  });
}

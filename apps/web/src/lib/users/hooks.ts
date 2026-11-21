import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  EmailChangeStatusDto,
  RequestEmailChangeInput,
  UserSessionDto,
  ChangePasswordInput,
  UpdateProfileInput,
  UpdateUserInput,
  UserDetailDto,
  UserLimitsDto,
} from '@storageos/shared';

export const usersQueryKey = ['users'] as const;
export const userQueryKey = (id: string) => ['users', id] as const;

export function useUsers() {
  return useQuery({
    queryKey: usersQueryKey,
    queryFn: () => apiFetch<UserDetailDto[]>('/users'),
    staleTime: 30_000,
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateUserInput }) =>
      apiFetch<UserDetailDto>(`/users/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: usersQueryKey });
    },
  });
}

export function useDeactivateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/users/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: usersQueryKey });
    },
  });
}

export function useTransferOwnership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (targetUserId: string) =>
      apiFetch<void>(`/users/${targetUserId}/transfer-ownership`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: usersQueryKey });
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProfileInput) =>
      apiFetch<UserDetailDto>('/me', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      apiFetch<void>('/me/change-password', {
        method: 'POST',
        json: input,
      }),
    // Cierra las demás sesiones y anula un cambio de email pendiente.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'sessions'] });
      void qc.invalidateQueries({ queryKey: ['me', 'email-change'] });
    },
  });
}

const mySessionsKey = ['me', 'sessions'] as const;

export function useMySessions() {
  return useQuery({
    queryKey: mySessionsKey,
    queryFn: () => apiFetch<UserSessionDto[]>('/me/sessions'),
  });
}

export function useRevokeMySession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/me/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: mySessionsKey }),
  });
}

export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ revoked: number }>('/me/sessions/revoke-others', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: mySessionsKey }),
  });
}

const emailChangeKey = ['me', 'email-change'] as const;

export function useEmailChange() {
  return useQuery({
    queryKey: emailChangeKey,
    queryFn: () => apiFetch<EmailChangeStatusDto>('/me/email-change'),
  });
}

export function useRequestEmailChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RequestEmailChangeInput) =>
      apiFetch<EmailChangeStatusDto>('/me/email-change', { method: 'POST', json: input }),
    onSuccess: (data) => qc.setQueryData(emailChangeKey, data),
  });
}

export function useCancelEmailChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/me/email-change', { method: 'DELETE' }),
    onSuccess: () => qc.setQueryData(emailChangeKey, { pendingEmail: null, expiresAt: null }),
  });
}

export const userLimitsKey = ['users', 'limits'] as const;

/** Plazas de usuario del plan: activos + invitaciones pendientes frente al tope. */
export function useUserLimits(enabled = true) {
  return useQuery({
    queryKey: userLimitsKey,
    queryFn: () => apiFetch<UserLimitsDto>('/users/limits'),
    enabled,
    staleTime: 30_000,
  });
}

/** El propietario quita la verificación en dos pasos a otra persona del equipo. */
export function useResetUserTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/users/${id}/disable-2fa`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: usersQueryKey }),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  ChangePasswordInput,
  UpdateProfileInput,
  UpdateUserInput,
  UserDetailDto,
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
  return useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      apiFetch<void>('/me/change-password', {
        method: 'POST',
        json: input,
      }),
  });
}

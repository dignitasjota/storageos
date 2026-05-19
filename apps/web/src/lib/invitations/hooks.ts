import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { meQueryKey } from '../auth/hooks';
import { useAuthStore } from '../auth/store';

import type {
  AcceptInvitationInput,
  AuthSuccessResponse,
  InvitationDto,
  InviteUserInput,
  PublicInvitationDto,
} from '@storageos/shared';

export const invitationsQueryKey = ['invitations'] as const;
export const publicInvitationQueryKey = (token: string) => ['invitations', 'token', token] as const;

export function useInvitations() {
  return useQuery({
    queryKey: invitationsQueryKey,
    queryFn: () => apiFetch<InvitationDto[]>('/invitations'),
    staleTime: 30_000,
  });
}

export function useCreateInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteUserInput) =>
      apiFetch<InvitationDto>('/invitations', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: invitationsQueryKey });
    },
  });
}

export function useRevokeInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/invitations/${id}/revoke`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: invitationsQueryKey });
    },
  });
}

export function useResendInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<InvitationDto>(`/invitations/${id}/resend`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: invitationsQueryKey });
    },
  });
}

export function usePublicInvitation(token: string) {
  return useQuery({
    queryKey: publicInvitationQueryKey(token),
    queryFn: () =>
      apiFetch<PublicInvitationDto>(`/invitations/token/${token}`, {
        requiresAuth: false,
      }),
    enabled: token.length > 0,
    retry: false,
  });
}

export function useAcceptInvitation(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AcceptInvitationInput) =>
      apiFetch<AuthSuccessResponse>(`/invitations/token/${token}/accept`, {
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

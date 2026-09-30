'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  EmailDomainDto,
  EmailDomainResponseDto,
  UpsertEmailDomainInput,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const key = ['settings', 'tenant', 'email-domain'] as const;
const PATH = '/settings/tenant/email-domain';

export function useEmailDomain() {
  return useQuery({
    queryKey: key,
    queryFn: () => apiFetch<EmailDomainResponseDto>(PATH),
    select: (r): EmailDomainDto | null => r.emailDomain,
  });
}

export function useSaveEmailDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertEmailDomainInput) =>
      apiFetch<EmailDomainResponseDto>(PATH, { method: 'PUT', json: input }),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

export function useVerifyEmailDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<EmailDomainResponseDto>(`${PATH}/verify`, { method: 'POST' }),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

export function useRemoveEmailDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>(PATH, { method: 'DELETE' }),
    onSuccess: () => qc.setQueryData(key, { emailDomain: null }),
  });
}

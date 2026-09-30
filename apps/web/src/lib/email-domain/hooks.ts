'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CustomerEmailSettingsDto,
  EmailDomainDto,
  EmailDomainResponseDto,
  UpdateCustomerEmailSettingsInput,
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

const customerEmailsKey = ['settings', 'tenant', 'customer-emails'] as const;
const CUSTOMER_EMAILS_PATH = '/settings/tenant/customer-emails';

/** Correos automáticos a los inquilinos (activados por defecto). */
export function useCustomerEmailSettings() {
  return useQuery({
    queryKey: customerEmailsKey,
    queryFn: () => apiFetch<CustomerEmailSettingsDto>(CUSTOMER_EMAILS_PATH),
  });
}

export function useUpdateCustomerEmailSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCustomerEmailSettingsInput) =>
      apiFetch<CustomerEmailSettingsDto>(CUSTOMER_EMAILS_PATH, { method: 'PATCH', json: input }),
    onSuccess: (data) => qc.setQueryData(customerEmailsKey, data),
  });
}

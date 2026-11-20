'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CustomerEmailKind,
  CustomerEmailPreviewDto,
  CustomerEmailPreviewLocale,
  CustomerEmailSettingsDto,
  CustomerEmailTestResultDto,
  EmailDomainDto,
  EmailReplyToDto,
  EmailDomainResponseDto,
  MyEmailNoticesDto,
  StaffEmailSettingsDto,
  UpdateCustomerEmailSettingsInput,
  UpdateEmailReplyToInput,
  UpdateStaffEmailSettingsInput,
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
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      void qc.invalidateQueries({ queryKey: replyToKey });
    },
  });
}

export function useVerifyEmailDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<EmailDomainResponseDto>(`${PATH}/verify`, { method: 'POST' }),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      void qc.invalidateQueries({ queryKey: replyToKey });
    },
  });
}

export function useRemoveEmailDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>(PATH, { method: 'DELETE' }),
    onSuccess: () => {
      qc.setQueryData(key, { emailDomain: null });
      void qc.invalidateQueries({ queryKey: replyToKey });
    },
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

const staffEmailsKey = ['settings', 'tenant', 'staff-emails'] as const;
const STAFF_EMAILS_PATH = '/settings/tenant/staff-emails';

const myNoticesKey = ['me', 'email-notices'] as const;

/** Avisos por correo que recibe el usuario (su perfil). */
export function useMyEmailNotices() {
  return useQuery({
    queryKey: myNoticesKey,
    queryFn: () => apiFetch<MyEmailNoticesDto>('/me/email-notices'),
  });
}

export function useUpdateMyEmailNotices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateStaffEmailSettingsInput) =>
      apiFetch<MyEmailNoticesDto>('/me/email-notices', { method: 'PATCH', json: input }),
    onSuccess: (data) => qc.setQueryData(myNoticesKey, data),
  });
}

/** Avisos por email al equipo (activados por defecto). */
export function useStaffEmailSettings() {
  return useQuery({
    queryKey: staffEmailsKey,
    queryFn: () => apiFetch<StaffEmailSettingsDto>(STAFF_EMAILS_PATH),
  });
}

export function useUpdateStaffEmailSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateStaffEmailSettingsInput) =>
      apiFetch<StaffEmailSettingsDto>(STAFF_EMAILS_PATH, { method: 'PATCH', json: input }),
    onSuccess: (data) => qc.setQueryData(staffEmailsKey, data),
  });
}

/** Un correo al inquilino tal como lo recibe, con datos de ejemplo. */
export function useCustomerEmailPreview(
  kind: CustomerEmailKind | null,
  locale: CustomerEmailPreviewLocale,
) {
  return useQuery({
    queryKey: [...customerEmailsKey, 'preview', kind, locale] as const,
    queryFn: () =>
      apiFetch<CustomerEmailPreviewDto>(`${CUSTOMER_EMAILS_PATH}/${kind}/preview?locale=${locale}`),
    enabled: !!kind,
    staleTime: 60_000,
  });
}

/** Manda ese correo de ejemplo a quien lo pide. */
export function useSendCustomerEmailTest() {
  return useMutation({
    mutationFn: (args: { kind: CustomerEmailKind; locale: CustomerEmailPreviewLocale }) =>
      apiFetch<CustomerEmailTestResultDto>(`${CUSTOMER_EMAILS_PATH}/${args.kind}/test`, {
        method: 'POST',
        json: { locale: args.locale },
      }),
  });
}

const replyToKey = ['settings', 'tenant', 'email-reply-to'] as const;
const REPLY_TO_PATH = '/settings/tenant/email-reply-to';

/** A dónde llegan las respuestas de los inquilinos. */
export function useEmailReplyTo() {
  return useQuery({
    queryKey: replyToKey,
    queryFn: () => apiFetch<EmailReplyToDto>(REPLY_TO_PATH),
  });
}

export function useUpdateEmailReplyTo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateEmailReplyToInput) =>
      apiFetch<EmailReplyToDto>(REPLY_TO_PATH, { method: 'PUT', json: input }),
    onSuccess: (data) => qc.setQueryData(replyToKey, data),
  });
}

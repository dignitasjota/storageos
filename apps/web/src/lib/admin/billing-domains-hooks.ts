import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  BillingBatchResultDto,
  BillingCertificateRowDto,
  BillingIssueDetailDto,
  BillingIssuesPageDto,
  BillingNoticeKind,
  BillingNoticePreviewDto,
  BillingOtherProblemsDto,
  BillingStuckSubmissionDto,
  BillingTenantProblem,
  BillingVerifactuTenantDto,
  DomainCleanupDto,
  DomainFullCheckDto,
  DomainGuideDto,
  DomainHistoryItemDto,
  DomainOpsOverviewDto,
} from '@storageos/shared';

const BILLING = ['admin', 'billing-ops'] as const;
const DOMAINS = ['admin', 'domains'] as const;

// ------------------------------------------------------------ facturación

export function useBillingStuck(all: boolean) {
  return useQuery({
    queryKey: [...BILLING, 'stuck', all] as const,
    queryFn: () =>
      adminApiFetch<BillingStuckSubmissionDto[]>(`/admin/billing-ops/stuck${all ? '?all=1' : ''}`),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useRetryStuck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { tenantId: string; ownerId: string | null }) =>
      adminApiFetch<{ scheduledAt: string }>('/admin/billing-ops/stuck/retry', {
        method: 'POST',
        json: v,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: BILLING }),
  });
}

export function useBillingVerifactuTenants(problem: BillingTenantProblem | 'all', search: string) {
  const qs = new URLSearchParams();
  if (problem !== 'all') qs.set('problem', problem);
  if (search.trim()) qs.set('search', search.trim());
  return useQuery({
    queryKey: [...BILLING, 'tenants', problem, search.trim()] as const,
    queryFn: () =>
      adminApiFetch<BillingVerifactuTenantDto[]>(`/admin/billing-ops/tenants?${qs.toString()}`),
    placeholderData: keepPreviousData,
  });
}

export function billingIssuesQuery(p: {
  type: string;
  tenantId: string;
  cursor?: string;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (p.type !== 'all') qs.set('type', p.type);
  if (p.tenantId) qs.set('tenantId', p.tenantId);
  if (p.cursor) qs.set('cursor', p.cursor);
  qs.set('limit', String(p.limit ?? 25));
  return qs;
}

export function useBillingIssues(p: {
  type: string;
  tenantId: string;
  cursor: string | undefined;
}) {
  const qs = billingIssuesQuery(p);
  return useQuery({
    queryKey: [...BILLING, 'issues', p.type, p.tenantId, p.cursor ?? ''] as const,
    queryFn: () =>
      adminApiFetch<BillingIssuesPageDto>(`/admin/billing-ops/issues?${qs.toString()}`),
    placeholderData: keepPreviousData,
  });
}

export function useBillingIssueDetail(invoiceId: string | null) {
  return useQuery({
    queryKey: [...BILLING, 'detail', invoiceId] as const,
    queryFn: () => adminApiFetch<BillingIssueDetailDto>(`/admin/billing-ops/invoices/${invoiceId}`),
    enabled: !!invoiceId,
    staleTime: 0,
  });
}

export function useBillingInvoiceXml() {
  return useMutation({
    mutationFn: (invoiceId: string) =>
      adminApiFetch<{ xml: string | null }>(`/admin/billing-ops/invoices/${invoiceId}/xml`),
  });
}

export function useBillingResend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { invoiceId: string; reason: string }) =>
      adminApiFetch<{ message: string }>(`/admin/billing-ops/invoices/${v.invoiceId}/resend`, {
        method: 'POST',
        json: { reason: v.reason },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BILLING });
      void qc.invalidateQueries({ queryKey: ['admin', 'billing-health'] });
    },
  });
}

export function useBillingBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { action: 'refresh' | 'resend'; invoiceIds: string[]; reason?: string }) =>
      adminApiFetch<BillingBatchResultDto>('/admin/billing-ops/invoices/batch', {
        method: 'POST',
        json: v,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BILLING });
      void qc.invalidateQueries({ queryKey: ['admin', 'billing-health'] });
    },
  });
}

export function useBillingCertificates() {
  return useQuery({
    queryKey: [...BILLING, 'certificates'] as const,
    queryFn: () =>
      adminApiFetch<BillingCertificateRowDto[]>('/admin/billing-ops/certificates?days=60'),
  });
}

export function useBillingOther() {
  return useQuery({
    queryKey: [...BILLING, 'other'] as const,
    queryFn: () => adminApiFetch<BillingOtherProblemsDto>('/admin/billing-ops/other'),
  });
}

export interface BillingNoticeInput {
  tenantId: string;
  kind: BillingNoticeKind;
  message?: string;
  credentialId?: string;
}

export function useBillingNoticePreview(input: BillingNoticeInput | null) {
  return useQuery({
    queryKey: [...BILLING, 'notice-preview', input] as const,
    queryFn: () =>
      adminApiFetch<BillingNoticePreviewDto>('/admin/billing-ops/notices/preview', {
        method: 'POST',
        json: input,
      }),
    enabled: !!input,
    staleTime: 0,
    retry: false,
  });
}

export function useBillingSendNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BillingNoticeInput) =>
      adminApiFetch<{ sent: number; failed: number }>('/admin/billing-ops/notices', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] }),
  });
}

// --------------------------------------------------------------- dominios

export function useDomainOps() {
  return useQuery({
    queryKey: [...DOMAINS, 'overview'] as const,
    queryFn: () => adminApiFetch<DomainOpsOverviewDto>('/admin/domains/overview'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useDomainCheckNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) =>
      adminApiFetch<DomainFullCheckDto>(`/admin/domains/${tenantId}/check`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DOMAINS });
      void qc.invalidateQueries({ queryKey: ['admin', 'custom-domains'] });
    },
  });
}

export function useDomainCheckAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      adminApiFetch<{ checked: number; failing: number }>('/admin/domains/check-all', {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DOMAINS });
      void qc.invalidateQueries({ queryKey: ['admin', 'custom-domains'] });
    },
  });
}

export function useDomainGuide(tenantId: string | null) {
  return useQuery({
    queryKey: [...DOMAINS, 'guide', tenantId] as const,
    queryFn: () => adminApiFetch<DomainGuideDto>(`/admin/domains/${tenantId}/guide`),
    enabled: !!tenantId,
    staleTime: 0,
  });
}

export function useDomainChecklist(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (steps: Record<string, boolean>) =>
      adminApiFetch<DomainGuideDto>(`/admin/domains/${tenantId}/checklist`, {
        method: 'PUT',
        json: { steps },
      }),
    onSuccess: (data) => {
      qc.setQueryData([...DOMAINS, 'guide', tenantId], data);
      void qc.invalidateQueries({ queryKey: [...DOMAINS, 'overview'] });
    },
  });
}

export function useDomainHistory(tenantId: string | null) {
  return useQuery({
    queryKey: [...DOMAINS, 'history', tenantId] as const,
    queryFn: () => adminApiFetch<DomainHistoryItemDto[]>(`/admin/domains/${tenantId}/history`),
    enabled: !!tenantId,
    staleTime: 0,
  });
}

export function useDomainCleanups() {
  return useQuery({
    queryKey: [...DOMAINS, 'cleanups'] as const,
    queryFn: () => adminApiFetch<DomainCleanupDto[]>('/admin/domains/cleanups'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useDomainCleanupDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<DomainCleanupDto>(`/admin/domains/cleanups/${id}/done`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: DOMAINS }),
  });
}

export function useDomainNotifySetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notifyTenantEnabled: boolean) =>
      adminApiFetch<{ notifyTenantEnabled: boolean }>('/admin/domains/settings', {
        method: 'PUT',
        json: { notifyTenantEnabled },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...DOMAINS, 'overview'] }),
  });
}

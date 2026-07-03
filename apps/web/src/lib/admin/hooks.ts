import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';
import { useAdminAuthStore } from './auth-store';

import type {
  AdminAddonAnalyticsDto,
  AdminTenantNotesDto,
  UpdateTenantNotesInput,
  AdminTrialDto,
  AdminChangePlanPreviewDto,
  AdminFinanceOverviewDto,
  PlatformBillingSettingsDto,
  PlatformInvoiceDto,
  UpdatePlatformBillingSettingsInput,
  DunningRunResultDto,
  PlatformDunningSettingsDto,
  UpdatePlatformDunningSettingsInput,
  PlatformBannerDto,
  LegalDocumentDto,
  LegalSlug,
  UpdateLegalDocumentInput,
  UpdatePlatformBannerInput,
  SuperAdminNotificationDto,
  AddTicketMessageInput,
  AdminAdoptionDto,
  AdminAtRiskDto,
  AdminCustomDomainDto,
  AssignAddonInput,
  SaasAddonDto,
  TenantBillingSummaryDto,
  AdminTodayDto,
  TenantLimitsDto,
  UpsertSaasAddonInput,
  AdminOnboardingDto,
  AdminTenantFeaturesDto,
  AdminImpersonationSessionDto,
  AdminImpersonationActivityDto,
  PlatformAlertSettingsDto,
  PlatformAlertRunResultDto,
  UpdatePlatformAlertSettingsInput,
  AdminTenantHealthDto,
  TenantFeature,
  AdminBroadcastInput,
  AdminBroadcastResultDto,
  AdminEmailTenantInput,
  AdminEmailTenantResultDto,
  AdminChurnByReasonDto,
  AdminMetricsDto,
  AdminMetricsMrrMovementsDto,
  AdminPaymentRetryAnalysisDto,
  AdminRetentionDto,
  AdminSystemHealthDto,
  AdminTenantActionInput,
  SuspendTenantInput,
  AdminTenantCustomerDto,
  AdminTenantDto,
  AdminUpdateTenantInput,
  AdminTenantFacilityDto,
  AdminTenantInvoicingDto,
  AdminTenantUnitDto,
  AdminTenantUserDto,
  AnonymizeTenantResultDto,
  AssignTicketInput,
  ChangePlanInput,
  ExtendTrialInput,
  SubscriptionPlanDto,
  UpsertSubscriptionPlanFormInput,
  ImpersonateInput,
  ImpersonationTokenDto,
  SecurityEventTypeValue,
  SecurityEventsListResponseDto,
  SuperAdminAuditLogsListResponseDto,
  CreateSuperAdminInput,
  SuperAdminDto,
  SuperAdminLoginInput,
  SuperAdminLoginRequires2faResponse,
  SuperAdminRecoveryCodesResponse,
  SuperAdminSessionDto,
  SuperAdminSetup2faResponse,
  SuperAdminTwoFactorChallengeInput,
  SuperAdminTwoFactorDisableInput,
  SuperAdminTwoFactorStatusResponse,
  SuperAdminTwoFactorVerifyInput,
  SupportTicketDto,
  SupportTicketPriorityValue,
  SupportTicketStatusValue,
  CreateManualSaasPaymentInput,
  CreateTenantFollowupInput,
  CreateTenantInteractionInput,
  TenantFollowupDto,
  TenantInteractionDto,
  TenantSubscriptionPaymentDto,
  TransitionTicketInput,
} from '@storageos/shared';

// ============================================================================
// Auth — login / refresh / logout / me
// ============================================================================

export const adminMeKey = ['admin', 'me'] as const;

type AdminLoginResponse = SuperAdminSessionDto | SuperAdminLoginRequires2faResponse;

export function useAdminMe() {
  const token = useAdminAuthStore((s) => s.superAdminToken);
  return useQuery({
    queryKey: adminMeKey,
    queryFn: () => adminApiFetch<SuperAdminDto>('/admin/auth/me'),
    enabled: Boolean(token),
    staleTime: 60_000,
    retry: false,
  });
}

export function useAdminLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SuperAdminLoginInput) =>
      adminApiFetch<AdminLoginResponse>('/admin/auth/login', {
        method: 'POST',
        json: input,
        requiresAuth: false,
      }),
    onSuccess: (data) => {
      // Si requires2fa la sesion aun no esta abierta — esperamos a que la
      // pantalla complete el challenge.
      if ('requires2fa' in data) return;
      useAdminAuthStore.getState().setSession(data.accessToken, data.admin);
      qc.setQueryData(adminMeKey, data.admin);
    },
  });
}

export function useAdmin2faChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SuperAdminTwoFactorChallengeInput) =>
      adminApiFetch<SuperAdminSessionDto>('/admin/auth/2fa/challenge', {
        method: 'POST',
        json: input,
        requiresAuth: false,
      }),
    onSuccess: (data) => {
      useAdminAuthStore.getState().setSession(data.accessToken, data.admin);
      qc.setQueryData(adminMeKey, data.admin);
    },
  });
}

export function useAdminLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await adminApiFetch<void>('/admin/auth/logout', { method: 'POST' });
      } catch {
        // Ignoramos: aunque el backend rechace, limpiamos local.
      }
    },
    onSettled: () => {
      useAdminAuthStore.getState().clear();
      qc.removeQueries({ queryKey: ['admin'] });
    },
  });
}

// ============================================================================
// 2FA management
// ============================================================================

export const admin2faStatusKey = ['admin', '2fa', 'status'] as const;

export function useAdmin2faStatus(enabled = true) {
  const token = useAdminAuthStore((s) => s.superAdminToken);
  return useQuery({
    queryKey: admin2faStatusKey,
    queryFn: () => adminApiFetch<SuperAdminTwoFactorStatusResponse>('/admin/auth/2fa/status'),
    enabled: enabled && Boolean(token),
    staleTime: 0,
    retry: false,
  });
}

export function useAdmin2faSetup() {
  return useMutation({
    mutationFn: () =>
      adminApiFetch<SuperAdminSetup2faResponse>('/admin/auth/2fa/setup', { method: 'POST' }),
  });
}

export function useAdmin2faVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SuperAdminTwoFactorVerifyInput) =>
      adminApiFetch<SuperAdminRecoveryCodesResponse>('/admin/auth/2fa/verify', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: admin2faStatusKey });
    },
  });
}

export function useAdmin2faDisable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SuperAdminTwoFactorDisableInput) =>
      adminApiFetch<void>('/admin/auth/2fa/disable', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      // Backend revoca todas las sesiones del admin tras desactivar 2FA —
      // limpiamos store; el layout redirige a /admin/login.
      useAdminAuthStore.getState().clear();
      qc.removeQueries({ queryKey: ['admin'] });
    },
  });
}

export function useAdmin2faRegenerateRecoveryCodes() {
  const qc = useQueryClient();
  return useMutation({
    // El backend no pide body en este endpoint.
    mutationFn: () =>
      adminApiFetch<SuperAdminRecoveryCodesResponse>('/admin/auth/2fa/recovery-codes/regenerate', {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: admin2faStatusKey });
    },
  });
}

// ============================================================================
// Tenants
// ============================================================================

export interface AdminTenantsFilters {
  status?: string | undefined;
  search?: string | undefined;
}

export const adminTenantsKey = (filters?: AdminTenantsFilters) =>
  ['admin', 'tenants', filters ?? {}] as const;

export function useAdminTenants(filters?: AdminTenantsFilters) {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set('status', filters.status);
  if (filters?.search) qs.set('search', filters.search);
  return useQuery({
    queryKey: adminTenantsKey(filters),
    queryFn: () =>
      adminApiFetch<AdminTenantDto[]>(`/admin/tenants${qs.toString() ? `?${qs}` : ''}`),
  });
}

export function useAdminTenant(id: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'tenants', id] as const,
    queryFn: () => adminApiFetch<AdminTenantDto>(`/admin/tenants/${id}`),
    enabled: Boolean(id),
  });
}

/** Edita datos básicos del tenant (soporte). */
export function useUpdateTenant(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminUpdateTenantInput) =>
      adminApiFetch<AdminTenantDto>(`/admin/tenants/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'tenants', id] }),
  });
}

export type TenantUserActionName =
  | 'resend-verification'
  | 'password-reset'
  | 'revoke-sessions'
  | 'disable-2fa'
  | 'deactivate'
  | 'reactivate';

/** Acción de soporte sobre un usuario del tenant (POST al endpoint correspondiente). */
export function useTenantUserAction(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, action }: { userId: string; action: TenantUserActionName }) =>
      adminApiFetch<{ ok?: true; revoked?: number }>(
        `/admin/tenants/${tenantId}/users/${userId}/${action}`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'tenants', tenantId, 'users'] });
      qc.invalidateQueries({ queryKey: ['admin', 'tenants', tenantId] });
    },
  });
}

/** Usuarios del tenant; `enabled` para cargarlos solo al abrir el desglose. */
export function useAdminTenantUsers(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'tenants', id, 'users'] as const,
    queryFn: () => adminApiFetch<AdminTenantUserDto[]>(`/admin/tenants/${id}/users`),
    enabled: Boolean(id) && enabled,
  });
}

/** Inquilinos del tenant; `enabled` para cargarlos al abrir el desglose. */
export function useAdminTenantCustomers(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'tenants', id, 'customers'] as const,
    queryFn: () => adminApiFetch<AdminTenantCustomerDto[]>(`/admin/tenants/${id}/customers`),
    enabled: Boolean(id) && enabled,
  });
}

/** Facturación del negocio del tenant; `enabled` para cargarla al abrir. */
export function useAdminTenantInvoicing(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'tenants', id, 'invoicing'] as const,
    queryFn: () => adminApiFetch<AdminTenantInvoicingDto>(`/admin/tenants/${id}/invoicing`),
    enabled: Boolean(id) && enabled,
  });
}

/** Locales del tenant; `enabled` para cargarlos al abrir el drill-down. */
export function useAdminTenantFacilities(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'tenants', id, 'facilities'] as const,
    queryFn: () => adminApiFetch<AdminTenantFacilityDto[]>(`/admin/tenants/${id}/facilities`),
    enabled: Boolean(id) && enabled,
  });
}

/** Trasteros de un local del tenant; carga cuando hay `facilityId`. */
export function useAdminTenantFacilityUnits(
  id: string | undefined,
  facilityId: string | null | undefined,
) {
  return useQuery({
    queryKey: ['admin', 'tenants', id, 'facilities', facilityId, 'units'] as const,
    queryFn: () =>
      adminApiFetch<AdminTenantUnitDto[]>(`/admin/tenants/${id}/facilities/${facilityId}/units`),
    enabled: Boolean(id) && Boolean(facilityId),
  });
}

export function useSuspendTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: SuspendTenantInput }) =>
      adminApiFetch<AdminTenantDto>(`/admin/tenants/${args.id}/suspend`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
    },
  });
}

export function useReactivateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: AdminTenantActionInput }) =>
      adminApiFetch<AdminTenantDto>(`/admin/tenants/${args.id}/reactivate`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
    },
  });
}

export function useExtendTrial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: ExtendTrialInput }) =>
      adminApiFetch<AdminTenantDto>(`/admin/tenants/${args.id}/extend-trial`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      qc.invalidateQueries({ queryKey: ['admin', 'trials'] });
    },
  });
}

/** Catálogo de planes (endpoint público) para el selector de cambio de plan. */
export function useAdminSubscriptionPlans() {
  return useQuery({
    queryKey: ['admin', 'subscription-plans'],
    queryFn: () => adminApiFetch<SubscriptionPlanDto[]>('/subscription-plans'),
  });
}

export function useChangePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: ChangePlanInput }) =>
      adminApiFetch<AdminTenantDto>(`/admin/tenants/${args.id}/change-plan`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
    },
  });
}

/** Impacto (sin aplicar) de cambiar de plan: delta de precio, add-ons redundantes, over-límites. */
export function useChangePlanPreview(tenantId: string, planSlug: string, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'change-plan-preview', tenantId, planSlug],
    queryFn: () =>
      adminApiFetch<AdminChangePlanPreviewDto>(
        `/admin/tenants/${tenantId}/change-plan-preview?planSlug=${encodeURIComponent(planSlug)}`,
      ),
    enabled: enabled && Boolean(planSlug),
  });
}

export function useImpersonateTenant() {
  return useMutation({
    mutationFn: (args: { id: string; input: ImpersonateInput }) =>
      adminApiFetch<ImpersonationTokenDto>(`/admin/tenants/${args.id}/impersonate`, {
        method: 'POST',
        json: args.input,
      }),
  });
}

export function useAnonymizeTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: AdminTenantActionInput }) =>
      adminApiFetch<AnonymizeTenantResultDto>(`/admin/tenants/${args.id}/anonymize`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
    },
  });
}

// ============================================================================
// Metrics
// ============================================================================

export const adminMetricsKey = ['admin', 'metrics'] as const;

export function useAdminMetrics() {
  return useQuery({
    queryKey: adminMetricsKey,
    queryFn: () => adminApiFetch<AdminMetricsDto>('/admin/metrics'),
    staleTime: 30_000,
  });
}

export function useAdminMrrMovements() {
  return useQuery({
    queryKey: ['admin', 'metrics', 'mrr-movements'] as const,
    queryFn: () => adminApiFetch<AdminMetricsMrrMovementsDto>('/admin/metrics/mrr-movements'),
    staleTime: 60_000,
  });
}

export function useAdminRetention() {
  return useQuery({
    queryKey: ['admin', 'metrics', 'retention'] as const,
    queryFn: () => adminApiFetch<AdminRetentionDto>('/admin/metrics/retention'),
    staleTime: 60_000,
  });
}

export function useAdminChurnByReason(months = 12) {
  return useQuery({
    queryKey: ['admin', 'metrics', 'churn-by-reason', months] as const,
    queryFn: () =>
      adminApiFetch<AdminChurnByReasonDto>(`/admin/metrics/churn-by-reason?months=${months}`),
    staleTime: 60_000,
  });
}

export function useAdminPaymentRetries(months = 12) {
  return useQuery({
    queryKey: ['admin', 'metrics', 'payment-retries', months] as const,
    queryFn: () =>
      adminApiFetch<AdminPaymentRetryAnalysisDto>(
        `/admin/metrics/payment-retries?months=${months}`,
      ),
    staleTime: 60_000,
  });
}

// ============================================================================
// Support tickets (admin view)
// ============================================================================

export interface AdminSupportFilters {
  status?: SupportTicketStatusValue | undefined;
  priority?: SupportTicketPriorityValue | undefined;
  assignedAdminId?: string | undefined;
}

export const adminSupportTicketsKey = (filters?: AdminSupportFilters) =>
  ['admin', 'support', 'tickets', filters ?? {}] as const;

export function useAdminSupportTickets(filters?: AdminSupportFilters) {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set('status', filters.status);
  if (filters?.priority) qs.set('priority', filters.priority);
  if (filters?.assignedAdminId) qs.set('assignedAdminId', filters.assignedAdminId);
  return useQuery({
    queryKey: adminSupportTicketsKey(filters),
    queryFn: () =>
      adminApiFetch<SupportTicketDto[]>(`/admin/support/tickets${qs.toString() ? `?${qs}` : ''}`),
  });
}

export function useAdminSupportTicket(id: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'support', 'tickets', id] as const,
    queryFn: () => adminApiFetch<SupportTicketDto>(`/admin/support/tickets/${id}`),
    enabled: Boolean(id),
  });
}

export function useAddAdminTicketMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: AddTicketMessageInput }) =>
      adminApiFetch<SupportTicketDto>(`/admin/support/tickets/${args.id}/messages`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['admin', 'support', 'tickets', vars.id] });
      qc.invalidateQueries({ queryKey: ['admin', 'support', 'tickets'] });
    },
  });
}

export function useTransitionTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: TransitionTicketInput }) =>
      adminApiFetch<SupportTicketDto>(`/admin/support/tickets/${args.id}/transition`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['admin', 'support', 'tickets', vars.id] });
      qc.invalidateQueries({ queryKey: ['admin', 'support', 'tickets'] });
    },
  });
}

// ============================================================================
// Security events (Fase 11A.1)
// ============================================================================

export interface AdminSecurityEventsFilters {
  eventType?: SecurityEventTypeValue | undefined;
  emailAttempted?: string | undefined;
  fromDate?: string | undefined;
  toDate?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export const adminSecurityEventsKey = (filters?: AdminSecurityEventsFilters) =>
  ['admin', 'security-events', filters ?? {}] as const;

export function useAdminSecurityEvents(filters?: AdminSecurityEventsFilters) {
  const qs = new URLSearchParams();
  if (filters?.eventType) qs.set('eventType', filters.eventType);
  if (filters?.emailAttempted) qs.set('emailAttempted', filters.emailAttempted);
  if (filters?.fromDate) qs.set('fromDate', filters.fromDate);
  if (filters?.toDate) qs.set('toDate', filters.toDate);
  if (filters?.cursor) qs.set('cursor', filters.cursor);
  if (filters?.limit) qs.set('limit', String(filters.limit));
  return useQuery({
    queryKey: adminSecurityEventsKey(filters),
    queryFn: () =>
      adminApiFetch<SecurityEventsListResponseDto>(
        `/admin/security-events${qs.toString() ? `?${qs}` : ''}`,
      ),
    staleTime: 15_000,
  });
}

// ============================================================================
// Security dashboard stats
// ============================================================================

export interface SecurityEventStatsResponse {
  windowHours: number;
  bucket: 'hour' | 'day';
  bruteForceThreshold: number;
  total: number;
  byEventType: Array<{ eventType: string; count: number }>;
  topEmails: Array<{ email: string; count: number; exceedsThreshold: boolean }>;
  topIps: Array<{ ip: string; count: number; exceedsThreshold: boolean }>;
  timeseries: Array<{ bucket: string; count: number }>;
  activeAlerts: Array<{ kind: 'email' | 'ip'; identifier: string; count: number }>;
}

export const adminSecurityStatsKey = (window: '24h' | '7d' | '30d') =>
  ['admin', 'security-events', 'stats', window] as const;

export function useAdminSecurityStats(window: '24h' | '7d' | '30d' = '24h') {
  return useQuery({
    queryKey: adminSecurityStatsKey(window),
    queryFn: () =>
      adminApiFetch<SecurityEventStatsResponse>(`/admin/security-events/stats?window=${window}`),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// ============================================================================
// Super admin audit logs (Fase 12A.3)
// ============================================================================

export interface AdminAuditLogsFilters {
  superAdminId?: string | undefined;
  action?: string | undefined;
  targetTenantId?: string | undefined;
  fromDate?: string | undefined;
  toDate?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export const adminAuditLogsKey = (filters?: AdminAuditLogsFilters) =>
  ['admin', 'audit-logs', filters ?? {}] as const;

export function useAdminAuditLogs(filters?: AdminAuditLogsFilters) {
  const qs = new URLSearchParams();
  if (filters?.superAdminId) qs.set('superAdminId', filters.superAdminId);
  if (filters?.action) qs.set('action', filters.action);
  if (filters?.targetTenantId) qs.set('targetTenantId', filters.targetTenantId);
  if (filters?.fromDate) qs.set('fromDate', filters.fromDate);
  if (filters?.toDate) qs.set('toDate', filters.toDate);
  if (filters?.cursor) qs.set('cursor', filters.cursor);
  if (filters?.limit) qs.set('limit', String(filters.limit));
  return useQuery({
    queryKey: adminAuditLogsKey(filters),
    queryFn: () =>
      adminApiFetch<SuperAdminAuditLogsListResponseDto>(
        `/admin/audit-logs${qs.toString() ? `?${qs}` : ''}`,
      ),
    staleTime: 15_000,
  });
}

export function useAssignTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: AssignTicketInput }) =>
      adminApiFetch<SupportTicketDto>(`/admin/support/tickets/${args.id}/assign`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['admin', 'support', 'tickets', vars.id] });
      qc.invalidateQueries({ queryKey: ['admin', 'support', 'tickets'] });
    },
  });
}

// ============================================================================
// Webhooks cleanup dashboard
// ============================================================================

export interface WebhookCleanupStatsResponse {
  total: number;
  eligibleForCleanup: number;
  olderThanDays: number;
  cutoff: string;
  oldestAt: string | null;
  newestAt: string | null;
  byStatus: Array<{ status: string; count: number }>;
}

export const adminWebhooksCleanupStatsKey = (olderThanDays?: number) =>
  ['admin', 'webhooks-cleanup', 'stats', olderThanDays ?? 'default'] as const;

export function useAdminWebhooksCleanupStats(olderThanDays?: number) {
  const qs = olderThanDays ? `?olderThanDays=${olderThanDays}` : '';
  return useQuery({
    queryKey: adminWebhooksCleanupStatsKey(olderThanDays),
    queryFn: () => adminApiFetch<WebhookCleanupStatsResponse>(`/admin/webhooks-cleanup/stats${qs}`),
    staleTime: 30_000,
  });
}

export function useAdminWebhooksCleanupRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { olderThanDays?: number }) =>
      adminApiFetch<{ deleted: number; olderThanDays: number }>('/admin/webhooks-cleanup/run', {
        method: 'POST',
        json: args,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'webhooks-cleanup'] });
    },
  });
}

// ============================================================================
// Colas BullMQ
// ============================================================================

export interface AdminQueueStatus {
  name: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  };
  recentFailed: Array<{
    id: string;
    name: string;
    failedReason: string | null;
    attemptsMade: number;
    timestamp: string | null;
  }>;
}

export function useAdminQueues() {
  return useQuery({
    queryKey: ['admin', 'queues'],
    queryFn: () => adminApiFetch<AdminQueueStatus[]>('/admin/queues'),
    refetchInterval: 15_000,
  });
}

/** Envía un email directo a un tenant. */
export function useEmailTenant(id: string) {
  return useMutation({
    mutationFn: (input: AdminEmailTenantInput) =>
      adminApiFetch<AdminEmailTenantResultDto>(`/admin/tenants/${id}/email`, {
        method: 'POST',
        json: input,
      }),
  });
}

/** Envía un anuncio masivo a los tenants. */
export function useAdminBroadcast() {
  return useMutation({
    mutationFn: (input: AdminBroadcastInput) =>
      adminApiFetch<AdminBroadcastResultDto>('/admin/announcements', {
        method: 'POST',
        json: input,
      }),
  });
}

/** Tenants en riesgo (retención): trials por expirar, past_due, inactivos. */
export function useAdminAtRisk() {
  return useQuery({
    queryKey: ['admin', 'at-risk'],
    queryFn: () => adminApiFetch<AdminAtRiskDto>('/admin/tenants/at-risk'),
    refetchInterval: 60_000,
  });
}

export function useAdminCustomDomains() {
  return useQuery({
    queryKey: ['admin', 'custom-domains'],
    queryFn: () => adminApiFetch<AdminCustomDomainDto[]>('/admin/tenants/custom-domains'),
    refetchInterval: 60_000,
  });
}

export function useCustomDomainAction(action: 'verify' | 'revoke') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) =>
      adminApiFetch<AdminCustomDomainDto>(`/admin/tenants/${tenantId}/custom-domain/${action}`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'custom-domains'] });
    },
  });
}

// --- Add-ons facturables del SaaS ---
export function useAdminAddons() {
  return useQuery({
    queryKey: ['admin', 'addons'],
    queryFn: () => adminApiFetch<SaasAddonDto[]>('/admin/addons'),
  });
}

export function useUpsertAddon(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertSaasAddonInput) =>
      adminApiFetch<SaasAddonDto>(id ? `/admin/addons/${id}` : '/admin/addons', {
        method: id ? 'PATCH' : 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'addons'] }),
  });
}

export function useTenantBillingSummary(tenantId: string) {
  return useQuery({
    queryKey: ['admin', 'tenant-billing-summary', tenantId],
    queryFn: () =>
      adminApiFetch<TenantBillingSummaryDto>(`/admin/tenants/${tenantId}/billing-summary`),
    enabled: Boolean(tenantId),
  });
}

export function useTenantLimits(tenantId: string) {
  return useQuery({
    queryKey: ['admin', 'tenant-limits', tenantId],
    queryFn: () => adminApiFetch<TenantLimitsDto>(`/admin/tenants/${tenantId}/limits`),
    enabled: Boolean(tenantId),
  });
}

export function useAssignAddon(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignAddonInput) =>
      adminApiFetch<TenantBillingSummaryDto>(`/admin/tenants/${tenantId}/addons`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant-billing-summary', tenantId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
    },
  });
}

export function useRemoveAddon(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) =>
      adminApiFetch<TenantBillingSummaryDto>(`/admin/tenants/${tenantId}/addons/${assignmentId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant-billing-summary', tenantId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
    },
  });
}

/** Suspender / reactivar un add-on por impago (action: 'suspend' | 'reactivate'). */
export function useAddonSuspension(tenantId: string, action: 'suspend' | 'reactivate') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) =>
      adminApiFetch<TenantBillingSummaryDto>(
        `/admin/tenants/${tenantId}/addons/${assignmentId}/${action}`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant-billing-summary', tenantId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant-limits', tenantId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'today'] });
    },
  });
}

/** Nº de tickets de soporte esperando respuesta del admin — para el badge del menú. */
export function useAdminOpenTicketsCount() {
  return useQuery({
    queryKey: ['admin', 'support', 'open-count'],
    queryFn: () => adminApiFetch<{ count: number }>('/admin/support/tickets/open-count'),
    refetchInterval: 60_000,
  });
}

export function useAdminTenantsHealth() {
  return useQuery({
    queryKey: ['admin', 'tenants', 'health'] as const,
    queryFn: () => adminApiFetch<AdminTenantHealthDto[]>('/admin/tenants/health'),
    refetchInterval: 300_000,
  });
}

export function useAdminAdoption() {
  return useQuery({
    queryKey: ['admin', 'tenants', 'adoption'] as const,
    queryFn: () => adminApiFetch<AdminAdoptionDto>('/admin/tenants/adoption'),
    staleTime: 60_000,
  });
}

export function useAdminTenantHealth(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'tenants', id, 'health'] as const,
    queryFn: () => adminApiFetch<AdminTenantHealthDto>(`/admin/tenants/${id}/health`),
    enabled: Boolean(id) && enabled,
  });
}

/** Salud de las dependencias de infraestructura (status page). */
export function useAdminSystemHealth() {
  return useQuery({
    queryKey: ['admin', 'system-health'],
    queryFn: () => adminApiFetch<AdminSystemHealthDto>('/admin/system-health'),
    refetchInterval: 15_000,
  });
}

/** Reintentar / limpiar los jobs fallidos de una cola. */
export function useQueueFailedAction(action: 'retry-failed' | 'clean-failed') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (queueName: string) =>
      adminApiFetch<{ retried?: number; cleaned?: number }>(
        `/admin/queues/${queueName}/${action}`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'queues'] }),
  });
}

export function useAdminTenantSaasPayments(id: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'tenants', id, 'saas-payments'] as const,
    queryFn: () =>
      adminApiFetch<TenantSubscriptionPaymentDto[]>(`/admin/tenants/${id}/saas-payments`),
    enabled: Boolean(id),
  });
}

export function useSyncTenantSaasPayments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<{ synced: number }>(`/admin/tenants/${id}/saas-payments/sync`, {
        method: 'POST',
      }),
    onSuccess: (_data, id) =>
      qc.invalidateQueries({ queryKey: ['admin', 'tenants', id, 'saas-payments'] }),
  });
}

/**
 * Datos auxiliares para el diálogo de pago manual: precio mensual y divisa del
 * plan del tenant (para sugerir la duración) + fin de periodo actual.
 */
export function useAddManualPaymentDeps(tenantId: string) {
  const tenant = useAdminTenant(tenantId);
  const plans = useAdminSubscriptionPlans();
  const billing = useTenantBillingSummary(tenantId);
  const slug = tenant.data?.subscription?.planSlug ?? null;
  const plan = (plans.data ?? []).find((p) => p.slug === slug) ?? null;
  return {
    planPriceMonthly: plan?.priceMonthly ?? null,
    /** Importe mensual efectivo (plan + add-ons); para sugerir la duración. */
    effectiveMonthly: billing.data?.effectiveMonthly ?? null,
    planCurrency: plan?.currency ?? 'EUR',
    periodEnd: tenant.data?.subscription?.currentPeriodEnd ?? null,
    hasStripe: Boolean(tenant.data?.subscription?.stripeSubscriptionId),
  };
}

export function useAddManualSaasPayment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateManualSaasPaymentInput) =>
      adminApiFetch<TenantSubscriptionPaymentDto>(`/admin/tenants/${id}/saas-payments/manual`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      // Refresca los pagos y el detalle del tenant (el periodo de suscripción cambió).
      qc.invalidateQueries({ queryKey: ['admin', 'tenants', id, 'saas-payments'] });
      qc.invalidateQueries({ queryKey: ['admin', 'tenants', id] });
    },
  });
}

// ============================================================================
// Tenant interactions — histórico de conversaciones con el tenant
// ============================================================================

export function useAdminTenantInteractions(id: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'tenants', id, 'interactions'] as const,
    queryFn: () => adminApiFetch<TenantInteractionDto[]>(`/admin/tenants/${id}/interactions`),
    enabled: Boolean(id),
  });
}

export function useCreateTenantInteraction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantInteractionInput) =>
      adminApiFetch<TenantInteractionDto>(`/admin/tenants/${id}/interactions`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'tenants', id, 'interactions'] }),
  });
}

export function useDeleteTenantInteraction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (interactionId: string) =>
      adminApiFetch<void>(`/admin/tenants/${id}/interactions/${interactionId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'tenants', id, 'interactions'] }),
  });
}

// --- Seguimientos / recordatorios ------------------------------------------

/** Bandeja global de seguimientos pendientes. */
export function useAdminFollowupsPending() {
  return useQuery({
    queryKey: ['admin', 'followups', 'pending'] as const,
    queryFn: () => adminApiFetch<TenantFollowupDto[]>('/admin/followups'),
    refetchInterval: 60_000,
  });
}

export function useAdminTenantFollowups(id: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'tenants', id, 'followups'] as const,
    queryFn: () => adminApiFetch<TenantFollowupDto[]>(`/admin/tenants/${id}/followups`),
    enabled: Boolean(id),
  });
}

export function useCreateFollowup(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantFollowupInput) =>
      adminApiFetch<TenantFollowupDto>(`/admin/tenants/${id}/followups`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants', id, 'followups'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'followups', 'pending'] });
    },
  });
}

/** Marca un seguimiento como hecho / lo reabre (bandeja global). */
export function useUpdateFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { followupId: string; status: 'pending' | 'done' }) =>
      adminApiFetch<TenantFollowupDto>(`/admin/followups/${args.followupId}`, {
        method: 'PATCH',
        json: { status: args.status },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'followups', 'pending'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
    },
  });
}

export function useDeleteFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (followupId: string) =>
      adminApiFetch<void>(`/admin/followups/${followupId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'followups', 'pending'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
    },
  });
}

/** Features (plan + overrides) de un tenant. */
export function useAdminTenantFeatures(id: string, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'tenant', id, 'features'] as const,
    queryFn: () => adminApiFetch<AdminTenantFeaturesDto>(`/admin/tenants/${id}/features`),
    enabled,
  });
}

export function useSetTenantFeatures(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (overrides: { feature: TenantFeature; enabled: boolean }[]) =>
      adminApiFetch<AdminTenantFeaturesDto>(`/admin/tenants/${id}/features`, {
        method: 'PUT',
        json: { overrides },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id, 'features'] });
    },
  });
}

/** Checklist de puesta a punto de un tenant. */
export function useAdminTenantOnboarding(id: string, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'tenant', id, 'onboarding'] as const,
    queryFn: () => adminApiFetch<AdminOnboardingDto>(`/admin/tenants/${id}/onboarding`),
    enabled,
  });
}

// ============================================================================
// Super admins (CRUD)
// ============================================================================

export function useAdminSuperAdmins() {
  return useQuery({
    queryKey: ['admin', 'super-admins'] as const,
    queryFn: () => adminApiFetch<SuperAdminDto[]>('/admin/super-admins'),
  });
}

export function useCreateSuperAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSuperAdminInput) =>
      adminApiFetch<SuperAdminDto>('/admin/super-admins', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'super-admins'] }),
  });
}

export function useSetSuperAdminActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; isActive: boolean }) =>
      adminApiFetch<SuperAdminDto>(`/admin/super-admins/${args.id}/active`, {
        method: 'PATCH',
        json: { isActive: args.isActive },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'super-admins'] }),
  });
}

// ============================================================================
// Alertas proactivas de plataforma
// ============================================================================

export function useAdminPlatformAlerts() {
  return useQuery({
    queryKey: ['admin', 'platform-alerts'] as const,
    queryFn: () => adminApiFetch<PlatformAlertSettingsDto>('/admin/platform-alerts'),
  });
}

export function useUpdatePlatformAlerts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformAlertSettingsInput) =>
      adminApiFetch<PlatformAlertSettingsDto>('/admin/platform-alerts', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'platform-alerts'] }),
  });
}

export function useRunPlatformAlerts() {
  return useMutation({
    mutationFn: () =>
      adminApiFetch<PlatformAlertRunResultDto>('/admin/platform-alerts/run', { method: 'POST' }),
  });
}

// ============================================================================
// Auditoría de impersonación
// ============================================================================

export function useAdminImpersonationLogs() {
  return useQuery({
    queryKey: ['admin', 'impersonation-logs'] as const,
    queryFn: () => adminApiFetch<AdminImpersonationSessionDto[]>('/admin/impersonation-logs'),
  });
}

export function useAdminImpersonationActivity(id: string | null) {
  return useQuery({
    queryKey: ['admin', 'impersonation-logs', id, 'activity'] as const,
    queryFn: () =>
      adminApiFetch<AdminImpersonationActivityDto[]>(`/admin/impersonation-logs/${id}/activity`),
    enabled: Boolean(id),
  });
}

// ============================================================================
// Gestión de planes (CRUD)
// ============================================================================

/** Todos los planes incluyendo inactivos (gestión). */
export function useAdminAllPlans() {
  return useQuery({
    queryKey: ['admin', 'subscription-plans', 'all'] as const,
    queryFn: () => adminApiFetch<SubscriptionPlanDto[]>('/subscription-plans/admin'),
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertSubscriptionPlanFormInput) =>
      adminApiFetch<SubscriptionPlanDto>('/subscription-plans', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'subscription-plans'] }),
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: Partial<UpsertSubscriptionPlanFormInput> }) =>
      adminApiFetch<SubscriptionPlanDto>(`/subscription-plans/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'subscription-plans'] }),
  });
}

export function useDeactivatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/subscription-plans/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'subscription-plans'] }),
  });
}

// --- Facturación del SaaS (StorageOS → tenant) ---
export function useAdminPlatformBillingSettings() {
  return useQuery({
    queryKey: ['admin', 'platform-billing', 'settings'] as const,
    queryFn: () => adminApiFetch<PlatformBillingSettingsDto>('/admin/platform-billing/settings'),
  });
}

export function useUpdatePlatformBillingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformBillingSettingsInput) =>
      adminApiFetch<PlatformBillingSettingsDto>('/admin/platform-billing/settings', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['admin', 'platform-billing', 'settings'] }),
  });
}

export function useAdminTenantPlatformInvoices(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'tenant', tenantId, 'platform-invoices'] as const,
    queryFn: () =>
      adminApiFetch<PlatformInvoiceDto[]>(`/admin/tenants/${tenantId}/platform-invoices`),
    enabled,
  });
}

export function useIssuePlatformInvoice(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) =>
      adminApiFetch<PlatformInvoiceDto>('/admin/platform-invoices/issue', {
        method: 'POST',
        json: { paymentId },
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId, 'platform-invoices'] }),
  });
}

/** Devuelve la URL firmada del PDF para abrirla. */
export async function fetchPlatformInvoicePdf(id: string): Promise<string> {
  const res = await adminApiFetch<{ url: string }>(`/admin/platform-invoices/${id}/pdf`);
  return res.url;
}

// --- Dunning del SaaS ---
export function useAdminPlatformDunningSettings() {
  return useQuery({
    queryKey: ['admin', 'platform-dunning', 'settings'] as const,
    queryFn: () => adminApiFetch<PlatformDunningSettingsDto>('/admin/platform-dunning/settings'),
  });
}

export function useUpdatePlatformDunningSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformDunningSettingsInput) =>
      adminApiFetch<PlatformDunningSettingsDto>('/admin/platform-dunning/settings', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['admin', 'platform-dunning', 'settings'] }),
  });
}

export function useRunDunning() {
  return useMutation({
    mutationFn: () =>
      adminApiFetch<DunningRunResultDto>('/admin/platform-dunning/run', { method: 'POST' }),
  });
}

// --- Banner global + notificaciones del super admin ---
export function useAdminPlatformBanner() {
  return useQuery({
    queryKey: ['admin', 'platform', 'banner'] as const,
    queryFn: () => adminApiFetch<PlatformBannerDto>('/admin/platform/banner'),
  });
}

export function useUpdatePlatformBanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformBannerInput) =>
      adminApiFetch<PlatformBannerDto>('/admin/platform/banner', { method: 'PUT', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'platform', 'banner'] }),
  });
}

export function useAdminNotifications() {
  const token = useAdminAuthStore((s) => s.superAdminToken);
  return useQuery({
    queryKey: ['admin', 'platform', 'notifications'] as const,
    queryFn: () => adminApiFetch<SuperAdminNotificationDto[]>('/admin/platform/notifications'),
    enabled: Boolean(token),
  });
}

export function useAdminNotifUnreadCount() {
  const token = useAdminAuthStore((s) => s.superAdminToken);
  return useQuery({
    queryKey: ['admin', 'platform', 'notifications', 'unread'] as const,
    queryFn: () => adminApiFetch<{ count: number }>('/admin/platform/notifications/unread-count'),
    enabled: Boolean(token),
    refetchInterval: 60_000,
  });
}

export function useMarkNotifsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      adminApiFetch<void>('/admin/platform/notifications/read-all', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'platform', 'notifications'] });
    },
  });
}

// ============================================================================
// Documentos legales (términos, privacidad)
// ============================================================================

export function useAdminLegalDoc(slug: LegalSlug) {
  return useQuery({
    queryKey: ['admin', 'legal', slug] as const,
    queryFn: () => adminApiFetch<LegalDocumentDto>(`/admin/platform/legal/${slug}`),
  });
}

export function useUpdateLegalDoc(slug: LegalSlug) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateLegalDocumentInput) =>
      adminApiFetch<LegalDocumentDto>(`/admin/platform/legal/${slug}`, {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'legal', slug] }),
  });
}

// --- «Hoy» del super admin ---
export function useAdminToday() {
  return useQuery({
    queryKey: ['admin', 'today'],
    queryFn: () => adminApiFetch<AdminTodayDto>('/admin/today'),
    refetchInterval: 60_000,
  });
}

export function useChargeAddon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantAddonId, provider }: { tenantAddonId: string; provider: string }) =>
      adminApiFetch<AdminTodayDto>(`/admin/today/addon-charges/${tenantAddonId}/charge`, {
        method: 'POST',
        json: { provider },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'today'] });
    },
  });
}

export function useAdminFinance(months = 12) {
  return useQuery({
    queryKey: ['admin', 'finance', months],
    queryFn: () => adminApiFetch<AdminFinanceOverviewDto>(`/admin/finance?months=${months}`),
    refetchInterval: 60_000,
  });
}

export function useAddonAnalytics() {
  return useQuery({
    queryKey: ['admin', 'addon-analytics'],
    queryFn: () => adminApiFetch<AdminAddonAnalyticsDto[]>('/admin/addons/analytics'),
  });
}

export function useAdminTrials() {
  return useQuery({
    queryKey: ['admin', 'trials'],
    queryFn: () => adminApiFetch<AdminTrialDto[]>('/admin/tenants/trials'),
    refetchInterval: 60_000,
  });
}

export function useAdminTenantNotes(tenantId: string) {
  return useQuery({
    queryKey: ['admin', 'tenant-notes', tenantId],
    queryFn: () => adminApiFetch<AdminTenantNotesDto>(`/admin/tenants/${tenantId}/notes`),
    enabled: Boolean(tenantId),
  });
}

export function useUpdateTenantNotes(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantNotesInput) =>
      adminApiFetch<AdminTenantNotesDto>(`/admin/tenants/${tenantId}/notes`, {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'tenant-notes', tenantId] });
    },
  });
}

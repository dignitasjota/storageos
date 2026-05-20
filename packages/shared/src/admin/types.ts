import type {
  SecurityEventTypeValue,
  SuperAdminRoleValue,
  SupportTicketPriorityValue,
  SupportTicketStatusValue,
} from './schemas';

export interface SuperAdminDto {
  id: string;
  email: string;
  fullName: string;
  role: SuperAdminRoleValue;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SuperAdminSessionDto {
  accessToken: string;
  expiresIn: number;
  admin: SuperAdminDto;
}

/**
 * Respuesta de POST /admin/auth/login cuando el super admin tiene 2FA
 * activado. No emitimos sesion: el cliente debe llamar a /admin/auth/2fa/challenge.
 */
export interface SuperAdminLoginRequires2faResponse {
  requires2fa: true;
  pendingToken: string;
  /** TTL en segundos del pendingToken. */
  expiresIn: number;
}

/** Respuesta de POST /admin/auth/2fa/setup. */
export interface SuperAdminSetup2faResponse {
  otpauthUri: string;
  secretBase32: string;
  /** Data URL del QR (PNG base64) — listo para `<img src={qrCode} />`. */
  qrCode: string;
}

/**
 * Respuesta de POST /admin/auth/2fa/verify y .../recovery-codes/regenerate.
 * Los recovery codes se muestran al admin UNA SOLA VEZ.
 */
export interface SuperAdminRecoveryCodesResponse {
  recoveryCodes: string[];
}

/** Estado del 2FA del super admin (para /admin/settings/security). */
export interface SuperAdminTwoFactorStatusResponse {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
}

/** Respuesta de POST /admin/auth/refresh. */
export interface SuperAdminRefreshResponse {
  accessToken: string;
  expiresIn: number;
}

export interface AdminTenantDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  trialEndsAt: string | null;
  billingEmail: string | null;
  country: string;
  currency: string;
  createdAt: string;
  /** Conteos rápidos para la lista. */
  userCount: number;
  customerCount: number;
  contractCount: number;
  /** Plan + Stripe info. */
  subscription: {
    planSlug: string | null;
    planName: string | null;
    status: string;
    currentPeriodEnd: string | null;
    stripeSubscriptionId: string | null;
  } | null;
}

export interface ImpersonationTokenDto {
  /** Access token JWT con tenantId del target y adminUserId para auditoría. */
  accessToken: string;
  /** Tenant info para el panel de admin. */
  tenantName: string;
  tenantSlug: string;
  expiresIn: number;
}

export interface AdminMetricsDto {
  tenants: {
    total: number;
    trial: number;
    active: number;
    suspended: number;
    cancelled: number;
  };
  mrr: {
    total: number;
    currency: string;
  };
  signupsThisMonth: number;
  cancellationsThisMonth: number;
  churnRatePercent: number;
  averageRevenuePerTenant: number;
}

export interface SupportTicketDto {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  subject: string;
  status: SupportTicketStatusValue;
  priority: SupportTicketPriorityValue;
  category: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Pre-cargado en detail. */
  messages?: SupportTicketMessageDto[];
  unreadCount?: number;
}

export interface SupportTicketMessageDto {
  id: string;
  ticketId: string;
  body: string;
  isInternal: boolean;
  authorUserId: string | null;
  authorUserName: string | null;
  authorAdminId: string | null;
  authorAdminName: string | null;
  createdAt: string;
}

export interface SubscriptionPlanDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  currency: string;
  features: Record<string, unknown>;
  stripePriceId: string | null;
  isActive: boolean;
}

/**
 * DTO completo de la suscripcion del tenant para la pantalla de
 * /settings/saas-billing. Incluye los ids de Stripe (solo visibles para
 * owner) y los datos del plan.
 */
export interface TenantSubscriptionDto {
  id: string;
  tenantId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  plan: SubscriptionPlanDto;
}

/** Respuesta de POST /settings/saas-billing/checkout y .../portal. */
export interface BillingSessionResponseDto {
  url: string;
}

/**
 * DTO de un evento de seguridad para el panel admin (Fase 11A.1).
 *
 * Las fechas se serializan como ISO strings y `rawMetadata` viaja como
 * objeto plano (Prisma devuelve `JsonValue`, lo casteamos a record).
 */
export interface SecurityEventDto {
  id: string;
  occurredAt: string;
  eventType: SecurityEventTypeValue;
  emailAttempted: string | null;
  tenantSlugAttempted: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  reason: string | null;
  rawMetadata: Record<string, unknown> | null;
}

export interface SecurityEventsListResponseDto {
  items: SecurityEventDto[];
  nextCursor: string | null;
}

/**
 * DTO de una entrada de audit log del super admin (Fase 12A.3).
 *
 * `superAdminId` puede ser null si el actor no se llego a autenticar (por
 * ejemplo `admin.login.failed` con email inexistente). `changes` viaja como
 * objeto plano (Prisma devuelve `JsonValue`, lo casteamos a record o null).
 */
export interface SuperAdminAuditLogDto {
  id: string;
  occurredAt: string;
  superAdminId: string | null;
  superAdminEmail: string | null;
  superAdminFullName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetTenantId: string | null;
  changes: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface SuperAdminAuditLogsListResponseDto {
  items: SuperAdminAuditLogDto[];
  nextCursor: string | null;
}

/** Input para crear/actualizar un plan desde el panel admin. */
export interface UpsertSubscriptionPlanInput {
  slug: string;
  name: string;
  description?: string | null;
  priceMonthly: number;
  priceYearly: number;
  currency?: string;
  features?: Record<string, unknown>;
  stripePriceId?: string | null;
  maxUnits?: number | null;
  maxFacilities?: number | null;
  maxUsers?: number | null;
  isActive?: boolean;
}

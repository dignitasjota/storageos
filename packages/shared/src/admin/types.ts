import type {
  SecurityEventTypeValue,
  SuperAdminRoleValue,
  SupportTicketPriorityValue,
  SupportTicketStatusValue,
  TenantInteractionTypeValue,
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
  facilityCount: number;
  /** Plan + Stripe info. */
  subscription: {
    planSlug: string | null;
    planName: string | null;
    status: string;
    currentPeriodEnd: string | null;
    stripeSubscriptionId: string | null;
  } | null;
}

/** Un usuario (staff) de un tenant, visto desde el panel super admin. */
export interface AdminTenantUserDto {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  /** Rol base (owner | manager | staff | readonly). */
  role: string;
  /** Nombre del rol personalizado del tenant, si tiene uno asignado. */
  tenantRoleName: string | null;
  isActive: boolean;
  /** Si ha verificado su email. */
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  /** Locales asignados (facility scope); 0 = ve todos los locales. */
  facilitiesCount: number;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Un mes de la serie de facturación del negocio del tenant. */
export interface AdminTenantInvoicingMonthDto {
  /** Etiqueta corta, p. ej. "mar 26". */
  label: string;
  /** Facturado ese mes (total de facturas emitidas por issueDate). */
  invoiced: number;
  /** Cobrado ese mes (pagos succeeded por paidAt). */
  collected: number;
}

/**
 * Resumen de la facturación que el tenant emite a SUS inquilinos (el volumen de
 * su negocio), visto desde el panel super admin. No confundir con los pagos de
 * la suscripción SaaS (lo que el tenant nos paga: `TenantSubscriptionPaymentDto`).
 */
export interface AdminTenantInvoicingDto {
  currency: string;
  /** Total facturado histórico (facturas contables: ≠ draft/cancelled). */
  totalInvoiced: number;
  /** Total cobrado histórico (pagos succeeded). */
  totalCollected: number;
  /** Pendiente de cobro (facturas issued/overdue). */
  totalPending: number;
  /** Nº de facturas contables. */
  invoiceCount: number;
  /** Nº de facturas vencidas. */
  overdueCount: number;
  /** Importe medio por factura. */
  avgInvoice: number;
  /** Serie de los últimos 12 meses (más antiguo → actual). */
  monthly: AdminTenantInvoicingMonthDto[];
}

/** Un inquilino (customer) de un tenant, visto desde el panel super admin. */
export interface AdminTenantCustomerDto {
  id: string;
  /** Nombre completo (particular) o razón social (empresa). */
  name: string;
  /** 'individual' | 'company'. */
  customerType: string;
  email: string | null;
  phone: string | null;
  documentType: string | null;
  documentNumber: string | null;
  kycVerified: boolean;
  /** Nº total de contratos. */
  contractCount: number;
  /** Nº de contratos vigentes (active/ending). */
  activeContractCount: number;
  createdAt: string;
}

/** Un local (facility) de un tenant, visto desde el panel super admin. */
export interface AdminTenantFacilityDto {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  /** Nº de trasteros del local. */
  unitCount: number;
  /** Nº de trasteros ocupados. */
  occupiedCount: number;
}

/** Un trastero (unit) de un local, visto desde el panel super admin. */
export interface AdminTenantUnitDto {
  id: string;
  code: string;
  unitTypeName: string;
  /** Metros cuadrados (columna generada). */
  areaM2: number | null;
  /** Precio mensual del trastero. */
  basePriceMonthly: number;
  /** Estado (available | occupied | reserved | maintenance | ...). */
  status: string;
}

/** Resumen devuelto por `POST /admin/tenants/:id/anonymize` (RGPD). */
export interface AnonymizeTenantResultDto {
  tenantId: string;
  anonymizedCustomers: number;
  anonymizedUsers: number;
}

export interface ImpersonationTokenDto {
  /** Access token JWT con tenantId del target y adminUserId para auditoría. */
  accessToken: string;
  /** Tenant info para el panel de admin. */
  tenantName: string;
  tenantSlug: string;
  expiresIn: number;
}

/** Distribución de tenants por plan (para el gráfico de tarta + MRR por plan). */
export interface AdminMetricsPlanSliceDto {
  planSlug: string;
  planName: string;
  /** Nº de tenants con ese plan (cualquier estado de suscripción). */
  count: number;
  /** MRR aportado por los tenants activos de ese plan. */
  mrr: number;
}

/** Un mes de la serie de crecimiento (altas vs bajas de tenants). */
export interface AdminMetricsGrowthMonthDto {
  label: string;
  signups: number;
  cancellations: number;
}

/** Un mes de la serie de ingresos SaaS cobrados (lo que cobramos a los tenants). */
export interface AdminMetricsRevenueMonthDto {
  label: string;
  collected: number;
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
  /** Trials que expiran en los próximos 7 días (alerta). */
  trialsExpiringSoon: number;
  /** Tickets de soporte sin cerrar (open/in_progress/waiting_user). */
  openSupportTickets: number;
  /** Agregados de toda la plataforma (suma de todos los tenants). */
  platform: {
    facilities: number;
    units: number;
    customers: number;
    contracts: number;
    users: number;
  };
  /** Distribución de tenants por plan + MRR por plan. */
  tenantsByPlan: AdminMetricsPlanSliceDto[];
  /** Altas vs bajas de tenants, últimos 12 meses. */
  monthlyGrowth: AdminMetricsGrowthMonthDto[];
  /** Ingresos SaaS cobrados por mes (pagos de suscripción), últimos 12 meses. */
  monthlySaasRevenue: AdminMetricsRevenueMonthDto[];
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

/** Un pago de la suscripción SaaS de un tenant (panel super admin). */
export interface TenantSubscriptionPaymentDto {
  id: string;
  /** Origen del pago: 'stripe' | 'paypal' | 'cash' | 'bank_transfer' | 'other'. */
  provider: string;
  status: string;
  amount: number;
  /** Descuento aplicado sobre el precio de lista (solo pagos manuales). */
  discount: number | null;
  currency: string;
  planSlug: string | null;
  planName: string | null;
  description: string | null;
  /** Periodo cubierto por el pago (para ver pagos anuales por adelantado). */
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  invoiceUrl: string | null;
  pdfUrl: string | null;
  createdAt: string;
}

/**
 * Una interacción/conversación del super admin con un tenant (panel admin).
 * Réplica de `CustomerInteractionDto` pero el autor es un super admin.
 */
export interface TenantInteractionDto {
  id: string;
  type: TenantInteractionTypeValue;
  content: string;
  /** Cuándo ocurrió la conversación (ISO). */
  occurredAt: string;
  /** Super admin que la registró; null si su cuenta se borró. */
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
}

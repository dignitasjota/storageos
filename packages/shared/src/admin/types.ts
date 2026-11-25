import type { AdminBusinessGoalsDto, AdminPeriodComparisonDto } from './business';
import type {
  TenantChurnRiskLevel,
  HealthMainDragDto,
  PayProbabilityLevel,
} from './health-insights';
import type { PlatformLeadFollowupDto, PlatformLeadSource, PlatformLeadStage } from './leads';
import type {
  AdminForecastAccuracyDto,
  AdminForecastScenarioDto,
  AdminLastYearDto,
  AdminMrrBreakdownDto,
  AdminReconciliationInvoiceDto,
  AdminReconciliationPaymentDto,
} from './metrics-insights';
import type { SupportTicketWatcherDto } from './support';
import type { EmailDnsRecordDto } from '../email-domains';
import type { TenantFeature } from '../features';
import type { MessageAttachmentDto } from '../messages';
import type {
  ApprovalAction,
  PlatformCouponDiscountTypeValue,
  PlatformEmailKind,
  PlatformSenderCategory,
  SecurityEventTypeValue,
  SuperAdminRoleValue,
  SupportTicketPriorityValue,
  SupportTicketStatusValue,
  TenantFollowupStatusValue,
  TenantInteractionTypeValue,
  UpdatePlatformFooterInput,
  UpdatePlatformSeoInput,
  PlatformHomeTextsInput,
} from './schemas';

export interface SuperAdminDto {
  id: string;
  email: string;
  fullName: string;
  role: SuperAdminRoleValue;
  isActive: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /** Solo comerciales: su código. */
  salesCode?: string | null;
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
  /** La política de la plataforma obliga a tenerla. */
  required: boolean;
  /** Hasta cuándo se puede usar el panel sin ella (null = sin plazo pendiente). */
  deadline: string | null;
}

/** Una sesión abierta del panel admin. */
export interface SuperAdminOpenSessionDto {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  /** Es la de este navegador. */
  current: boolean;
}

export interface SecurityBlockDto {
  id: string;
  kind: 'ip' | 'email';
  value: string;
  reason: string | null;
  expiresAt: string | null;
  createdByName: string | null;
  createdAt: string;
}

/** Un job fallido con sus datos, para la lista paginada de una cola. */
export interface AdminFailedJobDto {
  id: string;
  name: string;
  failedReason: string | null;
  attemptsMade: number;
  timestamp: string | null;
  /** Datos del job en JSON, recortados. */
  data: string;
}

export interface AdminFailedJobsPageDto {
  items: AdminFailedJobDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PlatformSecuritySettingsDto {
  requireAdminTwoFactor: boolean;
  adminTwoFactorGraceDays: number;
  adminTwoFactorRequiredSince: string | null;
  alertCooldownMinutes: number;
  /** Super admins activos sin 2FA. */
  adminsWithoutTwoFactor: number;
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
  /** Cuenta exenta de facturación SaaS (interna/demo/partner): fuera de las métricas. */
  billingExempt: boolean;
  trialEndsAt: string | null;
  billingEmail: string | null;
  country: string;
  currency: string;
  timezone: string;
  taxId: string | null;
  billingLegalName: string | null;
  billingAddress: string | null;
  billingCity: string | null;
  billingPostalCode: string | null;
  /** Datos obligatorios que le faltan para que sus facturas de suscripción salgan completas. */
  billingMissing: string[];
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
    /** 'manual' | 'stripe' | 'sepa'. */
    billingMode: string;
  } | null;
  /**
   * Propietario del tenant (el usuario que registró la cuenta). Solo se incluye
   * en el detalle; permite avisar cuando aún no ha activado su cuenta (email sin
   * verificar) y ofrecer activarla/reenviar el email desde el panel admin.
   */
  owner?: AdminTenantOwnerDto | null;
  /** Anonimizado (RGPD): la ficha solo enseña lo que queda. */
  anonymizedAt?: string | null;
  /** Fecha y motivo de la baja (cancelado o suspendido). */
  canceledAt?: string | null;
  churnReason?: string | null;
  /** «Dar de baja» programada para esta fecha (aún sin aplicar). */
  cancelScheduledAt?: string | null;
  cancelScheduledReason?: string | null;
  cancelScheduledNote?: string | null;
  /** Anonimización programada para esta fecha (periodo de gracia). */
  anonymizeScheduledAt?: string | null;
}

/** Propietario del tenant, para las acciones de activación desde el admin. */
export interface AdminTenantOwnerDto {
  userId: string;
  email: string;
  fullName: string;
  emailVerified: boolean;
}

/** Página de tenants (cursor pagination). `nextCursor` = id del último item si hay más. */
export interface AdminTenantsListResponseDto {
  items: AdminTenantDto[];
  nextCursor: string | null;
}

/** Resultado de un email directo a un tenant. */
export interface AdminEmailTenantResultDto {
  /** Destinatarios a los que se envió con éxito. */
  recipients: number;
  failed: number;
}

/**
 * Resultado del playbook de retención (1 clic desde health/at-risk): un
 * seguimiento creado + un email de retención encolado a los owners.
 */
export interface RetentionPlaybookResultDto {
  /** Id del seguimiento creado (dueDate = hoy + 3 días). */
  followupId: string;
  /** Nº de destinatarios (owners verificados) a los que se encoló el email. */
  emailRecipients: number;
}

/** Resultado de un anuncio/broadcast a varios tenants. */
export interface AdminBroadcastResultDto {
  /** Nº de tenants alcanzados (con al menos un destinatario). */
  tenants: number;
  /**
   * Nº de correos encolados. Se envían en segundo plano: lo que llega o rebota
   * se ve en «Correos enviados».
   */
  recipients: number;
  /** Siempre 0: los fallos se ven en «Correos enviados» (se mantiene por compatibilidad). */
  failed: number;
  /** Tenants elegidos que no reciben el anuncio (de baja, sin destinatario). */
  skipped: number;
  /** Destinatarios que se dieron de baja de los anuncios comerciales. */
  optedOut: number;
}

/** Un tenant marcado "en riesgo" (retención) en el panel super admin. */
export interface AdminAtRiskTenantDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  planName: string | null;
  /** 'trial_expiring' | 'past_due' | 'inactive' | 'low_health' | 'trial_expired'. */
  reason: string;
  /** Fecha relevante (fin de trial / desde cuándo debe / último login), ISO o null. */
  since: string | null;
  /** Prueba que ya venció y aún no se ha cerrado. */
  expired?: boolean;
  /** Último playbook de retención (en los últimos 14 días), ISO. */
  playbookAt?: string | null;
  /** Texto legible del motivo. */
  detail: string;
  /** Impagos: lo que debe (una cuota por periodo vencido). */
  owedAmount?: number;
  owedPeriods?: number;
  /** Pruebas: cuánto la está usando, para decidir si llamar. */
  usage?: AdminTrialUsageDto;
  /** Lo que paga (o pagaría) al mes: plan y extras sin suspender. */
  monthly?: number;
  /** Estaba apartado y ha empeorado: vuelve a salir con el motivo. */
  reappeared?: boolean;
  reappearedReason?: string | null;
}

export interface AdminTrialUsageDto {
  facilities: number;
  units: number;
  contracts: number;
  lastLoginAt: string | null;
}

/** Tenants en riesgo agrupados por motivo. */
export interface AdminAtRiskDto {
  /** Trials que expiran en los próximos 7 días. */
  trialExpiring: AdminAtRiskTenantDto[];
  /** Suscripciones con pago fallido (past_due). */
  pastDue: AdminAtRiskTenantDto[];
  /** Activos sin actividad de usuario en 14+ días. */
  inactive: AdminAtRiskTenantDto[];
  /** Salud «en riesgo» o «dormida» que no salen arriba (mismo criterio que Salud). */
  lowHealth: AdminAtRiskTenantDto[];
  /** Pruebas caducadas sin pagar: activos en solo lectura con la suscripción caducada. */
  trialExpired: AdminAtRiskTenantDto[];
  /** Cuántos se han ignorado por ahora («ignorar N días»). */
  snoozedCount: number;
  /** Los ignorados ahora mismo, con su sección, hasta cuándo y el motivo. */
  snoozed: AdminAtRiskSnoozedDto[];
}

/** Un tenant ignorado en «En riesgo». */
export interface AdminAtRiskSnoozedDto {
  id: string;
  name: string;
  /** Sección ignorada; null = todas (ignorado antes de guardar la sección). */
  kind: string | null;
  until: string;
  reason: string | null;
}

/** Nivel de salud de un tenant según su puntuación 0-100. */
export type AdminTenantHealthLevel = 'healthy' | 'warm' | 'at_risk' | 'dormant';

/**
 * Grupo de un tenant en Salud:
 *  - `paying`: clientes que pagan (pagando o con el pago atrasado, cuota > 0).
 *  - `trial`: en prueba. Se mide su activación, no su salud de cliente.
 *  - `unpaid`: activos que no pagan (plan gratis, prueba terminada en solo
 *    lectura o suscripción cancelada).
 *  - `exempt`: cuentas exentas de facturación (las nuestras, demos, socios).
 */
export type AdminHealthSegment = 'paying' | 'trial' | 'unpaid' | 'exempt';

export const ADMIN_HEALTH_SEGMENTS: readonly AdminHealthSegment[] = [
  'paying',
  'trial',
  'unpaid',
  'exempt',
] as const;

/** Un factor de la puntuación (con su peso y puntuación 0-100). */
export interface AdminTenantHealthFactorDto {
  /** Clave estable (`engagement`, `billing`, `subscription`, `facility`, …). */
  key: string;
  label: string;
  /** Puntuación de este factor, 0-100. */
  score: number;
  /** Peso relativo en la puntuación total, 0-1 (0 si no cuenta). */
  weight: number;
  /** Si cuenta: un factor que no aplica (p. ej. sin contratos) no penaliza. */
  counted: boolean;
  /** Explicación legible de la señal (p. ej. "Último acceso hace 3 días"). */
  detail: string;
}

/**
 * Puntuación de un tenant: salud de cliente (`kind: 'health'`) o activación
 * de una prueba (`kind: 'activation'`), 0-100 ponderado + nivel + factores.
 */
export interface AdminTenantHealthDto {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  planName: string | null;
  segment: AdminHealthSegment;
  kind: 'health' | 'activation';
  /** Fin de la prueba (solo en prueba). */
  trialEndsAt: string | null;
  /** Puntuación final 0-100. */
  score: number;
  level: AdminTenantHealthLevel;
  factors: AdminTenantHealthFactorDto[];
  /** Último uso del panel por su equipo (inicio de sesión o sesión renovada). */
  lastActivityAt: string | null;
  /** Diferencia con la foto del mes pasado (null si no hay foto de ese mes). */
  trend: number | null;
  planSlug: string | null;
  tags: string[];
  /** Comercial asignado (null si ninguno). */
  salesRepId: string | null;
  salesRepName: string | null;
  /** Lo que paga al mes sin IVA (0 si no paga). */
  mrr: number;
  /** En prueba: lo que pagaría al mes sin IVA con su plan (null si no). */
  wouldPay: number | null;
  /**
   * Días distintos con alguien del equipo en el panel en los últimos 30 días y
   * usuarios distintos que entraron (de `totalUsers` activos). null = aún no hay
   * registro diario de este tenant.
   */
  activeDays30: number | null;
  activeUsers30: number | null;
  totalUsers: number;
  /** Clientes: riesgo de baja (según la puntuación y la tendencia). */
  churnRisk: TenantChurnRiskLevel | null;
  /** Pruebas: probabilidad de pagar (0-100) y su nivel. */
  payProbability: number | null;
  payProbabilityLevel: PayProbabilityLevel | null;
  /** Pruebas: días que le quedan (negativo si ya venció). */
  trialDaysLeft: number | null;
  /** El factor que más le resta y qué hacer. */
  mainDrag: HealthMainDragDto | null;
  /** Puntuación de las últimas 8 semanas (foto diaria, una por semana; la más antigua primero). */
  sparkline: number[];
}

/** Salud de un grupo de tenants (`GET /admin/tenants/health?segment=`). */
export interface AdminTenantsHealthDto {
  segment: AdminHealthSegment;
  /** Cuántos tenants hay en cada grupo (para las pestañas). */
  counts: Record<AdminHealthSegment, number>;
  /** Los del grupo pedido, de menor a mayor puntuación. */
  tenants: AdminTenantHealthDto[];
  /** Última foto diaria guardada (null si la tarea aún no ha corrido). */
  snapshotAt: string | null;
  /** MRR (sin IVA) de los del grupo en riesgo y dormidos. */
  mrrAtRisk: { atRisk: number; dormant: number; total: number };
}

/** Estado de una feature premium para un tenant (incluida en plan vs usada). */
export interface AdminTenantAdoptionFeatureDto {
  feature: TenantFeature;
  label: string;
  /** Incluida en el plan actual del tenant. */
  inPlan: boolean;
  /** Activada aparte del plan (extra contratado o cortesía del admin). */
  viaOverride: boolean;
  /** La usa de verdad (hay datos/config). */
  used: boolean;
  /**
   * Intensidad: cuántas veces la usó en 30 y en 90 días (consultas de IA,
   * remesas, entradas, recordatorios…). null = se mide por configuración activa.
   */
  uses30: number | null;
  uses90: number | null;
  /** La paga como extra contratado. */
  paidAddon: boolean;
}

/** Uso vs límite de un recurso (units/facilities/users); `max` null = ilimitado. */
export interface AdminTenantAdoptionUsageDto {
  units: number;
  maxUnits: number | null;
  facilities: number;
  maxFacilities: number | null;
  users: number;
  maxUsers: number | null;
}

/** Adopción de features + señales de upsell de un tenant. */
export interface AdminTenantAdoptionDto {
  tenantId: string;
  name: string;
  slug: string;
  planSlug: string | null;
  planName: string | null;
  features: AdminTenantAdoptionFeatureDto[];
  usage: AdminTenantAdoptionUsageDto;
  /**
   * Lo que aporta al mes sin IVA (como el MRR: plan con su descuento + extras).
   * 0 si no paga (en prueba, plan gratis o solo lectura).
   */
  monthlyPaid: number;
  /** Está en prueba. */
  inTrial: boolean;
  /** En prueba: lo que pagaría al mes sin IVA con su plan y extras (null si no). */
  wouldPay: number | null;
  /** Precio mensual sin IVA del plan recomendado (null si no es candidato). */
  recommendedPlanPrice: number | null;
  /** Usa alguna función que su plan no incluye (downgrade/legacy). */
  usesFeatureOutsidePlan: boolean;
  /** Topa o supera algún límite del plan (100 % o más). */
  tapsLimit: boolean;
  /** Está al 80 % o más de algún límite sin topar ninguno. */
  nearLimit: boolean;
  /** Qué límite topa o está cerca (p. ej. «9 de 10 trasteros (90 %)»). */
  limitDetail: string | null;
  /** Candidato a subir de plan (el plan recomendado es más caro que el actual). */
  isCandidate: boolean;
  recommendedPlanSlug: string | null;
  recommendedPlanName: string | null;
  status: string;
  tags: string[];
  salesRepId: string | null;
  salesRepName: string | null;
  /** Extras que paga y no usa (riesgo de que los dé de baja). */
  paidUnused: { feature: TenantFeature; label: string; addonName: string; monthly: number }[];
  /** Suma de lo que paga al mes sin IVA por esos extras. */
  paidUnusedMonthly: number;
}

/** Cuántos tenants usan cada feature premium (adopción global). */
export interface AdminFeatureAdoptionDto {
  feature: TenantFeature;
  label: string;
  /** Cómo se mide el uso (en 90 días donde hay fecha; si no, configuración activa). */
  signal: string;
  tenantsUsing: number;
  /** Tenants cuyo plan la incluye. */
  tenantsWithAccess: number;
  /** Usos de todos los tenants en 30 días (null = se mide por configuración). */
  uses30Total: number | null;
  /** Qué se cuenta en la intensidad («consultas», «remesas»…). */
  intensityUnit: string | null;
}

/** Vista de adopción/upsell del panel super admin. */
export interface AdminAdoptionDto {
  /** Tenants, candidatos a subir de plan primero. */
  tenants: AdminTenantAdoptionDto[];
  /** Resumen de adopción por función. */
  featureAdoption: AdminFeatureAdoptionDto[];
  /** Nº de tenants candidatos a subir de plan. */
  candidateCount: number;
  /** Nº de tenants cerca de algún límite (80 % o más sin topar). */
  nearLimitCount: number;
  /** Nº de tenants que pagan algún extra sin usarlo. */
  paidUnusedCount: number;
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
  /** El inquilino de prueba de la puesta en marcha. */
  isTest?: boolean;
  /** Borrado en su panel (se lista para ver su historia). */
  deletedAt?: string | null;
  /** Pendiente de cobro (emitido sin cobrar, como en el Resumen) y la parte vencida. */
  debt?: number;
  overdueDebt?: number;
}

/** Una página de inquilinos de un tenant (`GET /admin/tenants/:id/customers/page`). */
export interface AdminTenantCustomersPageDto {
  items: AdminTenantCustomerDto[];
  nextCursor: string | null;
  /** Total con el filtro (sin paginar). */
  total: number;
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
  isActive?: boolean;
}

/** Una página de locales de un tenant (`GET /admin/tenants/:id/facilities/page`). */
export interface AdminTenantFacilitiesPageDto {
  items: AdminTenantFacilityDto[];
  nextCursor: string | null;
  total: number;
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
  /** Sesión de solo lectura (permisos de `readonly`, sin escrituras). */
  readOnly: boolean;
}

/** Distribución de tenants por plan (para el gráfico de tarta + MRR por plan). */
export interface AdminMetricsPlanSliceDto {
  planSlug: string;
  planName: string;
  /**
   * Nº de tenants vivos con ese plan (sin suspendidos, cancelados, borrados ni
   * los que quedaron en solo lectura tras una prueba sin pagar).
   */
  count: number;
  /** De ellos, los que están en prueba. */
  trial: number;
  /** De ellos, los que pagan (suman al MRR). */
  paying: number;
  /** MRR (sin IVA) de la cuota del plan de los que pagan; los extras van aparte. */
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

/** Desglose del cambio de MRR de un mes (todos en la divisa del SaaS, EUR). */
export interface AdminMetricsMrrMovementMonthDto {
  label: string;
  /** MRR de tenants nuevos (primer mes con suscripción). */
  newMrr: number;
  /** Aumento por upgrades de plan. */
  expansion: number;
  /** MRR recuperado de tenants que vuelven tras una baja. */
  reactivation: number;
  /** Reducción por downgrades (valor positivo; se resta). */
  contraction: number;
  /** MRR perdido por bajas (valor positivo; se resta). */
  churn: number;
  /** Net New MRR = new + expansion + reactivation − contraction − churn. */
  net: number;
  /** MRR total al cierre del mes. */
  endingMrr: number;
  /** Net Revenue Retention del mes (%); null si no había MRR base. */
  nrr: number | null;
}

/** Serie de MRR movements para el panel de métricas. */
export interface AdminMetricsMrrMovementsDto {
  currency: string;
  months: AdminMetricsMrrMovementMonthDto[];
  /** true si aún no hay suficientes snapshots para mostrar movimientos. */
  warmingUp: boolean;
}

/** Una cohorte de retención (tenants registrados el mismo mes). */
export interface AdminRetentionCohortDto {
  /** Etiqueta del mes de alta, p. ej. "ene 26". */
  cohort: string;
  /** Nº de tenants registrados ese mes. */
  size: number;
  /**
   * Retención % por offset de mes desde el alta: índice 0 = M0 (=100), 1 = M1…
   * `null` para offsets que aún no han ocurrido (mes futuro para esa cohorte)
   * y para los meses de una cohorte sin altas.
   */
  retention: (number | null)[];
  /** MRR inicial de la cohorte (el primer MRR de cada cliente), sin IVA. */
  startMrr: number;
  /**
   * % del MRR inicial que se conserva a los N meses del primer pago de cada
   * cliente (NRR por cohorte; puede pasar de 100). `null` sin datos.
   */
  revenueRetention: (number | null)[];
}

/** Matriz de cohortes de retención de tenants (por mes de alta). */
export interface AdminRetentionDto {
  /** Nº máximo de offset (columnas M0..Mn). */
  maxOffset: number;
  /** Cohortes de la más antigua a la más reciente. */
  cohorts: AdminRetentionCohortDto[];
}

/** Estado de un servicio de infraestructura (status page del admin). */
export interface AdminSystemServiceDto {
  /** 'database' | 'redis' | 'minio' | 'worker'. */
  key: string;
  label: string;
  status: 'up' | 'down';
  /** Info extra: último latido del worker, mensaje de error, etc. */
  detail: string | null;
  latencyMs: number | null;
}

export interface AdminSystemHealthDto {
  checkedAt: string;
  services: AdminSystemServiceDto[];
}

export interface AdminMetricsDto {
  tenants: {
    total: number;
    trial: number;
    /** Activos y al día (también los de un plan gratuito). */
    active: number;
    /** Activos con un pago atrasado (siguen en el MRR hasta que se suspenden). */
    pastDue: number;
    /** Prueba terminada sin pagar: cuenta en solo lectura (ni cliente ni baja). */
    readOnly: number;
    suspended: number;
    cancelled: number;
  };
  /** MRR sin IVA: cuota real (anual entre 12, con su descuento) + extras. */
  mrr: {
    total: number;
    currency: string;
  };
  /** Desglose del MRR: plan mensual, anual repartido, extras y descuentos. */
  mrrBreakdown: AdminMrrBreakdownDto;
  /** Las mismas cifras del mismo mes del año pasado. */
  lastYear: AdminLastYearDto;
  signupsThisMonth: number;
  /**
   * Bajas del mes de tenants que llegaron a pagar (cancelados o suspendidos,
   * también los anonimizados, o en solo lectura tras dejar de pagar).
   */
  cancellationsThisMonth: number;
  churnRatePercent: number;
  /** MRR / tenants que pagan (sin IVA). */
  averageRevenuePerTenant: number;
  /** Tenants que pagan ahora (los que suman al MRR). */
  payingTenants: number;
  /** Pruebas que terminaron este mes y en qué acabaron. */
  trialsEndedThisMonth: {
    ended: number;
    /** Pagan un plan. */
    converted: number;
    /** Terminaron sin pagar (solo lectura, plan gratuito o suspendidos sin haber pagado). */
    toFree: number;
    /** Pagaron y después se dieron de baja. */
    churned: number;
  };
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
  /** Totales del periodo elegido frente a los mismos meses justo antes. */
  period: AdminPeriodComparisonDto;
}

/** Página de tickets del panel admin (paginación por cursor). */
export interface AdminSupportTicketsPageDto {
  items: SupportTicketDto[];
  nextCursor: string | null;
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
  /** Primera respuesta del equipo (null = aún sin responder). */
  firstResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Pre-cargado en detail. */
  messages?: SupportTicketMessageDto[];
  unreadCount?: number;
  /** Valoración del tenant (1-5). */
  rating?: number | null;
  ratingComment?: string | null;
  /** Por qué se cerró: lo cerró el tenant, el soporte o se cerró por falta de respuesta. */
  closedReason?: SupportTicketClosedReason | null;
  /** Pantalla del panel desde la que se escribió y datos del navegador. */
  pageUrl?: string | null;
  userAgent?: string | null;
  screenSize?: string | null;
  /** Lo que respondió el asistente antes de abrir el ticket. */
  aiAnswer?: string | null;
  /** Compañeros en copia (en el detalle). */
  watchers?: SupportTicketWatcherDto[];
  /** Hasta cuándo el negocio puede reabrirlo (solo en cerrados; null si ya no). */
  reopenableUntil?: string | null;
}

export type SupportTicketClosedReason = 'tenant' | 'admin' | 'inactivity';

export interface SupportTicketMessageDto {
  id: string;
  ticketId: string;
  body: string;
  isInternal: boolean;
  authorUserId: string | null;
  authorUserName: string | null;
  authorAdminId: string | null;
  authorAdminName: string | null;
  /** Imagen o PDF adjunto (URL firmada), o null. */
  attachment: MessageAttachmentDto | null;
  /** Todos los adjuntos del mensaje. */
  attachments: MessageAttachmentDto[];
  createdAt: string;
}

export interface SubscriptionPlanDto {
  /** Solo en el catálogo público: los precios incluyen el IVA (true) o son +IVA (false). */
  pricesIncludeVat?: boolean;
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number;
  currency: string;
  features: Record<string, unknown>;
  /** Features premium que incluye este plan (gating por plan, editable). */
  tenantFeatures: TenantFeature[];
  stripePriceId: string | null;
  /** Stripe Price anual (opcional). Null si el plan no ofrece anualidad. */
  stripePriceIdYearly: string | null;
  maxUnits: number | null;
  maxFacilities: number | null;
  maxUsers: number | null;
  /** Trasteros incluidos en la cuota (plan Basic); null = cuota fija. */
  includedUnits: number | null;
  /** Precio de cada trastero por encima de los incluidos (null = no aplica). */
  extraUnitPrice: number | null;
  isActive: boolean;
  /** false = oculto: no sale en la web ni en el autoservicio. */
  isPublic: boolean;
  /** Solo en la lista del admin: tenants en el plan, los que pagan y su MRR. */
  tenantCount?: number;
  payingTenants?: number;
  mrr?: number;
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
  /** 'manual' | 'stripe' | 'sepa'. */
  billingMode: string;
  plan: SubscriptionPlanDto;
  /** Cuenta exenta (no paga cuota ni vence): la marca el super admin. */
  billingExempt: boolean;
  /**
   * Periodicidad que paga hoy por Stripe (`monthly` | `yearly`); null si no
   * paga por Stripe.
   */
  billingCycle: 'monthly' | 'yearly' | null;
  /**
   * Solo en la respuesta de un cambio de plan con cupón: false si el plan se
   * cambió pero el cupón no se pudo aplicar.
   */
  couponApplied?: boolean;
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
  /** Devuelto (reembolso, contracargo perdido o adeudo SEPA devuelto). */
  refundedAmount: number;
  /** Contracargo abierto. */
  disputed: boolean;
  /** Anulado por el super admin (pago a mano registrado por error). */
  voidedAt?: string | null;
  voidReason?: string | null;
  /** Se puede anular (pago a mano cobrado, sin devoluciones). */
  voidable?: boolean;
}

/**
 * Una interacción/conversación del super admin con un tenant (panel admin).
 * Réplica de `CustomerInteractionDto` pero el autor es un super admin.
 */
export interface TenantInteractionDto {
  id: string;
  type: TenantInteractionTypeValue;
  content: string;
  /** Enlace asociado (p. ej. al ticket de soporte que la originó); null si no tiene. */
  link: string | null;
  /** Cuándo ocurrió la conversación (ISO). */
  occurredAt: string;
  /** Super admin que la registró; null si su cuenta se borró. */
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
  /** Fijada arriba del historial. */
  pinned?: boolean;
}

/** Un seguimiento/recordatorio del super admin sobre un tenant. */
export interface TenantFollowupDto {
  id: string;
  tenantId: string;
  /** Nombre/slug del tenant (para la bandeja global). */
  tenantName: string;
  tenantSlug: string;
  title: string;
  note: string | null;
  /** Fecha de recordatorio (YYYY-MM-DD). */
  dueDate: string;
  status: TenantFollowupStatusValue;
  completedAt: string | null;
  authorName: string | null;
  /** Super admin que se encarga. */
  assignedToId: string | null;
  assignedToName: string | null;
  createdAt: string;
}

/** Features de un tenant en el panel admin: plan + overrides + efectivas. */
/** Una función activada o quitada a mano, por un extra o por una prueba gratis. */
export interface AdminFeatureOverrideDto {
  feature: TenantFeature;
  enabled: boolean;
  /** `manual` (cortesía), `addon` (extra contratado) o `trial` (prueba gratis de un extra). */
  source: 'manual' | 'addon' | 'trial';
  /** Fin de la cortesía o de la prueba, o null. */
  expiresAt: string | null;
  /** Extra en prueba (solo `trial`). */
  trialAddonName: string | null;
}

/** Cortesía o prueba gratis que vence pronto (bandeja «Hoy»). */
export interface AdminExpiringOverrideDto {
  tenantId: string;
  tenantName: string;
  feature: TenantFeature;
  source: 'manual' | 'trial';
  expiresAt: string;
  daysLeft: number;
  trialAddonName: string | null;
}

export interface AdminTenantFeaturesDto {
  planSlug: string | null;
  /** Features incluidas en el plan actual. */
  planFeatures: TenantFeature[];
  /** Overrides vigentes: cortesías del super admin, extras contratados y pruebas gratis. */
  overrides: AdminFeatureOverrideDto[];
  /** Features efectivas (plan + overrides). */
  effective: TenantFeature[];
}

/** Un paso del checklist de puesta a punto de un tenant. */
export interface AdminOnboardingItemDto {
  key: string;
  label: string;
  done: boolean;
}

/** Estado de configuración inicial de un tenant (para activación/customer success). */
export interface AdminOnboardingDto {
  items: AdminOnboardingItemDto[];
  completed: number;
  total: number;
}

/** Config de las alertas proactivas de plataforma (super admin). */
export interface PlatformAlertSettingsDto {
  enabled: boolean;
  alertEmail: string | null;
  notifyPastDue: boolean;
  notifyTrialExpiring: boolean;
  trialExpiringDays: number;
  /** Emails automáticos de ciclo de vida al tenant. */
  lifecycleEnabled: boolean;
  sendWelcome: boolean;
  sendTrialReminders: boolean;
  sendPastDue: boolean;
  /** Ayuda para arrancar en la prueba según el uso (días 3, 7 y 12). */
  sendActivation: boolean;
  /** Resumen semanal de KPIs por email al super admin (lunes 08:00). */
  weeklyDigestEnabled: boolean;
  instantAlertsEnabled: boolean;
  /** Hora (España) del aviso diario. */
  dailyHour: number;
  /** Avisar por chat de cada mensaje del formulario de contacto. */
  chatContactEnabled: boolean;
}

/** Un aviso enviado al administrador (email o chat). */
export interface PlatformAlertLogDto {
  id: string;
  channel: 'email' | 'telegram' | 'slack';
  kind: string;
  ok: boolean;
  error: string | null;
  summary: string;
  createdAt: string;
}

/** Consumo de correo de las últimas 24 horas por proveedor. */
export interface EmailProviderUsageDto {
  provider: string;
  sent: number;
  failed: number;
  bounced: number;
}

export interface EmailUsageDto {
  /** Proveedor principal configurado. */
  primary: string;
  providers: EmailProviderUsageDto[];
  /** Correos que salieron por un proveedor distinto del principal (respaldo). */
  viaFallback: number;
  /** Créditos que le quedan a la cuenta de Brevo (null si no se sabe). */
  brevoCreditsLeft: number | null;
  brevoPlan: string | null;
}

/** Resultado de evaluar las alertas ahora. */
export interface PlatformAlertRunResultDto {
  sent: boolean;
  pastDue: number;
  trialExpiring: number;
  reason: string | null;
}

/** Resultado de enviar el resumen semanal de KPIs ahora. */
export interface AdminWeeklyDigestResultDto {
  sent: boolean;
  reason: string | null;
}

/** Resultado de disparar los emails de ciclo de vida (nº encolado por categoría). */
export interface TenantLifecycleRunResultDto {
  welcome: number;
  trialReminders: number;
  pastDue: number;
  /** Pruebas vencidas sin pagar (pasan a solo lectura) en esta ejecución. */
  trialsEnded: number;
  /** Cuentas del plan gratuito avisadas (30 días antes) o pasadas a Basic. */
  freePlanMoves: number;
  /** Cuentas suspendidas tras 30 días en solo lectura sin pagar. */
  readOnlySuspended: number;
  /** Correos de ayuda para arrancar enviados (prueba sin local, inquilinos o facturas). */
  activationNudges: number;
  /** Avisos de cuenta suspendida enviados (días 0, 7 y 14). */
  suspensionNotices: number;
}

/** Una sesión de impersonación (super admin entrando como un tenant). */
export interface AdminImpersonationSessionDto {
  id: string;
  superAdminId: string;
  superAdminName: string | null;
  superAdminEmail: string | null;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  reason: string;
  /** Sesión de solo lectura. */
  readOnly: boolean;
  /** Acciones hechas dentro de esta sesión. */
  actionsCount: number;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** Usuario como el que se entró (null = el propietario). */
  userId?: string | null;
  userName?: string | null;
  /** Sigue abierta (sin cortar ni caducar). */
  live?: boolean;
}

/** Una acción del tenant registrada durante la ventana de una impersonación. */
export interface AdminImpersonationActivityDto {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  userName: string | null;
  occurredAt: string;
}

// --- Facturación del SaaS (TrasterOS → tenant) ---
export interface PlatformBillingSettingsDto {
  legalName: string;
  taxId: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string;
  email: string | null;
  taxRate: number;
  seriesPrefix: string;
  enabled: boolean;
  /** Los precios de planes y extras incluyen el IVA (true) o son +IVA (false). */
  pricesIncludeVat: boolean;
  /** Datos del emisor que faltan para poder activar la facturación. */
  missing: string[];
  /** Negocio propio de la SL incluido en la exportación para la asesoría. */
  ownTenant: { id: string; name: string; slug: string } | null;
}

export interface PlatformInvoiceDto {
  id: string;
  fullNumber: string;
  /** Factura del negocio propio que la respalda (null = numeración propia antigua). */
  ownTenantInvoiceId: string | null;
  tenantId: string;
  tenantName: string;
  tenantTaxId: string | null;
  planName: string | null;
  /** Concepto de la factura (capturado del pago, p. ej. «Add-on: X»; o «Suscripción {plan}»). */
  concept: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  baseAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  currency: string;
  status: string;
  issuedAt: string;
  hasPdf: boolean;
  paymentId: string | null;
  /** Datos obligatorios del destinatario que faltaban al emitirla (vacío = completa). */
  missing: string[];
  /** 'F1' o 'R1'/'R4' (rectificativa). */
  invoiceType: string;
  /** Factura que rectifica (solo rectificativas). */
  rectifies: { id: string; fullNumber: string } | null;
  rectificationReason: string | null;
  /** 'substitution' | 'differences' (solo rectificativas). */
  correctionMethod: string | null;
  /** Rectificativas emitidas sobre esta factura. */
  rectifiedBy: { id: string; fullNumber: string; correctionMethod: string | null; total: number }[];
  /** Desglose por líneas (plan + add-ons); vacío en facturas antiguas monolínea. */
  lines: PlatformInvoiceLineDto[];
}

/** Línea de detalle de una factura de plataforma. */
export interface PlatformInvoiceLineDto {
  id: string;
  /** 'plan' | 'addon' | 'adjustment'. */
  kind: string;
  description: string;
  quantity: number;
  unitAmount: number;
  baseAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
}

// --- Dunning del SaaS (cobro de tenants morosos) ---
export interface PlatformDunningSettingsDto {
  enabled: boolean;
  reminder1Days: number;
  reminder2Days: number;
  suspendDays: number;
}

export interface DunningRunResultDto {
  evaluated: number;
  reminders: number;
  suspended: number;
}

// --- Banner global + notificaciones del super admin ---
/** Lo que la web necesita para pintar el formulario de contacto (sin el email). */
export interface PublicContactFormDto {
  title: string;
  subtitle: string;
  showPhone: boolean;
  requirePhone: boolean;
  showCompany: boolean;
  showUnits: boolean;
  showProfile: boolean;
}

export interface PlatformWebsiteDto {
  /** URL pública del logo subido; null = el logo de la marca de la aplicación. */
  logoUrl: string | null;
  /** Formulario de contacto; null = desactivado o sin email de destino. */
  contactForm: PublicContactFormDto | null;
  /** Pie de la web (el guardado o el de por defecto). */
  footer: UpdatePlatformFooterInput;
  /** SEO de la web (guardado o por defecto) + imagen para redes subida. */
  seo: PlatformSeoDto;
  /** Textos propios de la portada; null en cada campo = el texto de serie. */
  home: PlatformHomeTextsInput;
}

export interface PlatformSeoDto extends UpdatePlatformSeoInput {
  /** Imagen para compartir en redes (1200×630); null = la generada con la marca. */
  ogImageUrl: string | null;
}

export interface PlatformContactSettingsDto extends PublicContactFormDto {
  enabled: boolean;
  email: string;
}

export interface PlatformContactMessageDto {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  units: string | null;
  profile: string | null;
  message: string;
  emailSent: boolean;
  handledAt: string | null;
  note: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  repliedAt: string | null;
  replySubject: string | null;
  replyBody: string | null;
  createdAt: string;
}

export interface PlatformContactMessagesPageDto {
  items: PlatformContactMessageDto[];
  nextCursor: string | null;
  /** Mensajes sin atender (todos, no solo los de la página). */
  pending: number;
}

export interface PlatformLogoUploadDto {
  uploadUrl: string;
  key: string;
  requiredHeaders: Record<string, string>;
}

export interface PlatformFounderOfferDto {
  enabled: boolean;
  title: string;
  text: string;
  setupStrike: string;
  setupText: string;
}

/** Banner que ve el tenant (el de más prioridad que le toca). */
export interface PlatformBannerDto {
  id: string;
  message: string;
  level: 'info' | 'warning' | 'critical';
  enabled: boolean;
  linkUrl: string | null;
  linkLabel: string | null;
  /** Deja de verse sola a esta hora (null = hasta que se apague). */
  endsAt: string | null;
  /** El usuario puede cerrarlo (los críticos no se cierran). */
  dismissible: boolean;
  /** Cambia al guardar: un banner nuevo vuelve a verse aunque se cerrara el anterior. */
  updatedAt: string;
}

export interface SuperAdminNotificationDto {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Un dominio propio de tenant en la cola de activación del super admin. */
export interface AdminCustomDomainDto {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  customDomain: string;
  /** null = pendiente de activar; ISO = activo. */
  verifiedAt: string | null;
  planSlug: string;
  /** Su plan o un extra le dan el dominio propio. */
  featureEnabled: boolean;
  /** El tenant dijo que ya configuró el DNS (o lo comprobó el aviso horario). */
  dnsReadyAt: string | null;
}

/** Un add-on del catálogo facturable del SaaS. */
export interface SaasAddonDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  feature: string | null;
  grantsUnits: number | null;
  grantsFacilities: number | null;
  grantsUsers: number | null;
  /** Consultas al mes del asistente IA que añade (por unidad). */
  grantsAiQueries: number | null;
  isActive: boolean;
  /** Price recurrente de Stripe mapeado (null = aún sin sincronizar). */
  stripePriceId: string | null;
  /** Precio por tramos de cantidad (vacío = precio único). */
  priceTiers: { minQuantity: number; unitPrice: number }[];
  /** Solo en estos planes (vacío = en cualquiera). */
  planSlugs: string[];
  /** Cantidad máxima por cliente (null = sin tope). */
  maxQuantity: number | null;
  /** De la plataforma: no se contrata ni se quita a mano. */
  isSystem: boolean;
  /** Tenants que lo tienen contratado (activo o suspendido). */
  tenantCount: number;
}

/** Un add-on contratado por un tenant. */
export interface TenantAddonDto {
  id: string;
  addonId: string;
  name: string;
  slug: string;
  priceMonthly: number;
  quantity: number;
  /** priceMonthly × quantity. */
  lineTotal: number;
  feature: string | null;
  notes:
    | string
    | null; /** Suspendido por impago: no cuenta al total ni a la capacidad, feature off. */
  suspended: boolean;
  /** Modo de cobro: 'manual' (bandeja «Hoy») | 'stripe' (subscription item). */
  billingMode: 'manual' | 'stripe';
  /** De la plataforma (p. ej. «Trasteros de más»): no se quita a mano. */
  isSystem: boolean;
  /** Próximo cobro a mano (null si va con la cuota, por Stripe o suspendido). */
  nextChargeAt?: string | null;
}

/** Resumen de la facturación efectiva del tenant (plan + add-ons). */
export interface TenantBillingSummaryDto {
  planName: string | null;
  planSlug: string | null;
  planMonthly: number;
  addons: TenantAddonDto[];
  addonsMonthly: number;
  /** planMonthly + addonsMonthly (precio de lista). */
  effectiveMonthly: number;
  /** Los precios incluyen el IVA (true) o son +IVA (false). */
  pricesIncludeVat: boolean;
  /** Lo que se cobra al mes: igual que `effectiveMonthly` con IVA incluido, o más el IVA. */
  effectiveMonthlyToCharge: number;
}

/** Límites efectivos del tenant (plan + add-ons de capacidad; null = ilimitado) con el uso actual. */
export interface TenantLimitsDto {
  units: { limit: number | null; used: number };
  facilities: { limit: number | null; used: number };
  users: { limit: number | null; used: number };
}

/** Vista de add-ons para el self-service del tenant: lo suyo + lo disponible. */
export interface TenantSelfAddonsDto {
  summary: TenantBillingSummaryDto;
  /** Add-ons del catálogo activos que el tenant aún no tiene ni incluye su plan. */
  available: SaasAddonDto[];
  /** Add-ons cuya función ya va en su plan: se muestran, pero no se contratan. */
  includedInPlan: SaasAddonDto[];
  /** Cuenta exenta: los extras no se le cobran. */
  billingExempt: boolean;
  /** Extras en prueba gratis, con su fin (para contratarlos antes de perderlos). */
  trials: { addonId: string; expiresAt: string }[];
}

/** Un add-on cuyo cobro manual toca (bandeja «Hoy» del super admin). */
export interface AdminAddonChargeDueDto {
  tenantAddonId: string;
  tenantId: string;
  tenantName: string;
  addonName: string;
  /** Importe mensual del add-on (precio × cantidad). */
  amount: number;
  currency: string;
  nextChargeAt: string;
  /** Días de retraso respecto a hoy (0 si vence hoy). */
  overdueDays: number;
  /** Estaba apartado y ha empeorado: vuelve a salir con el motivo. */
  reappeared?: boolean;
  reappearedReason?: string | null;
}

/** Panel «Hoy» del super admin: acciones pendientes del día. */
/** Suscripción de pago manual cuyo periodo vence pronto (o ya venció). */
export interface AdminManualRenewalDueDto {
  tenantId: string;
  tenantName: string;
  currentPeriodEnd: string;
  /** Días hasta el vencimiento (negativo = ya vencida). */
  daysLeft: number;
  /** Cuota mensual que se renueva. */
  monthly?: number;
  /** Estaba apartado y ha empeorado: vuelve a salir con el motivo. */
  reappeared?: boolean;
  reappearedReason?: string | null;
}

/** Add-on suspendido hace mucho (candidato a quitar definitivamente). */
export interface AdminStaleSuspendedAddonDto {
  tenantAddonId: string;
  tenantId: string;
  tenantName: string;
  addonName: string;
  suspendedAt: string;
  daysSuspended: number;
}

/** Ticket de soporte esperando respuesta del super admin (bandeja «Hoy»). */
/** Entregas de webhook salientes fallidas de un tenant (últimos 7 días). */
export interface AdminFailedWebhooksDto {
  tenantId: string;
  tenantName: string;
  failedCount: number;
  lastFailedAt: string;
  lastError: string | null;
  /** Estaba apartado y ha empeorado: vuelve a salir con el motivo. */
  reappeared?: boolean;
  reappearedReason?: string | null;
}

export interface AdminOpenTicketDto {
  id: string;
  tenantId: string;
  tenantName: string;
  subject: string;
  priority: SupportTicketPriorityValue;
  /** Días desde la última actividad del ticket (lleva N días esperando). */
  waitingDays: number;
  /** Último mensaje del tenant (o la apertura del ticket). */
  lastTenantMessageAt: string;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  /** Plazo de respuesta de su prioridad, en horas. */
  responseTargetHours: number;
  /** Cuándo vence el plazo (desde el último mensaje del cliente). */
  dueAt: string;
  /** Horas hasta que vence (negativo = fuera de plazo hace tantas horas). */
  dueInHours: number;
  /** Cuota mensual del tenant: lo que hay en juego. */
  monthly?: number;
  /** Estaba apartado y ha empeorado: vuelve a salir con el motivo. */
  reappeared?: boolean;
  reappearedReason?: string | null;
}

/** Trabajo de una cola que ha fallado en las últimas 24 h. */
export interface AdminTodayFailedJobDto {
  queue: string;
  id: string;
  name: string;
  /** Primera línea del motivo, recortada. */
  reason: string | null;
  failedAt: string;
  attempts: number;
}

/** Cobro de la suscripción rechazado en las últimas 48 h (el último de cada tenant). */
export interface AdminTodayPaymentFailureDto {
  tenantId: string;
  tenantName: string;
  /** Por dónde se intentó cobrar. */
  source: 'stripe' | 'redsys' | 'sepa' | 'other';
  amount: number;
  currency: string;
  reason: string;
  failedAt: string;
  /** Cobros rechazados de este tenant en la ventana. */
  failures: number;
  /** La cuota está impagada: se le puede enviar el recordatorio. */
  pastDue: boolean;
  reappeared?: boolean;
  reappearedReason?: string | null;
}

/** Cliente de pago cuyo equipo no entra desde hace 14 días o más. */
export interface AdminTodayInactiveDto {
  tenantId: string;
  tenantName: string;
  planName: string | null;
  monthly: number;
  /** Último acceso de su equipo (null = nunca). */
  lastLoginAt: string | null;
  daysSinceLogin: number | null;
  reappeared?: boolean;
  reappearedReason?: string | null;
}

/** Dinero en juego hoy (sobre lo que sale en la bandeja). */
export interface AdminTodayMoneyAtRiskDto {
  total: number;
  /** Deuda vencida de los impagos. */
  pastDue: number;
  /** Cuota de las pruebas que terminan en 3 días o menos. */
  trialsEnding: number;
  /** Cobros de extras por registrar. */
  addonCharges: number;
  /** Cuota de los clientes que han dejado de entrar. */
  inactive: number;
}

/** Un aviso de «Hoy» para el resumen de la última visita. */
export interface AdminTodayVisitItemDto {
  key: string;
  /** Clave de la sección (`ADMIN_TODAY_SECTION_LABELS`). */
  section: string;
  label: string;
  href: string;
}

/** «Desde tu última visita»: lo nuevo, lo resuelto y lo que ha empeorado. */
export interface AdminTodayVisitDto {
  /** Cuándo vio «Hoy» por última vez (null = primera vez). */
  previousVisitAt: string | null;
  /** Sale solo si la última visita fue hace 1 h o más. */
  show: boolean;
  newCount: number;
  resolvedCount: number;
  worseCount: number;
  /** Los primeros de cada lista (20 como mucho). */
  newItems: AdminTodayVisitItemDto[];
  resolvedItems: AdminTodayVisitItemDto[];
  worseItems: AdminTodayVisitItemDto[];
}

/** Resultado de una acción en lote o sobre varios trabajos de las colas. */
export interface AdminTodayBatchResultDto {
  done: number;
  failed: { ref: string; label: string; message: string }[];
}

/** Mensaje de la web de TrasterOS sin atender. */
/** Lead nuevo sin atender (aún nadie le ha respondido). */
export interface AdminTodayLeadDto {
  id: string;
  name: string;
  email: string | null;
  source: PlatformLeadSource;
  waitingHours: number;
  assignedToId: string | null;
  assignedToName: string | null;
}

/** Lead parado: lleva más días sin actividad de los que toca en su fase. */
export interface AdminTodayStaleLeadDto {
  id: string;
  name: string;
  status: PlatformLeadStage;
  staleDays: number;
  assignedToId: string | null;
  assignedToName: string | null;
  estimatedMonthly: number | null;
  /** De alto valor: cuenta como urgente. */
  highValue: boolean;
}

export interface AdminTodayDomainDto {
  tenantId: string;
  tenantName: string;
  domain: string;
}

/** Respuesta baja de una encuesta NPS de la plataforma (últimos 30 días). */
export interface AdminTodayNpsDto {
  id: string;
  tenantId: string;
  tenantName: string;
  score: number;
  comment: string | null;
}

/** Prueba de más de una semana que aún no ha firmado ningún contrato. */
export interface AdminTodayActivationDto {
  tenantId: string;
  tenantName: string;
  ownerEmail: string | null;
  daysSinceSignup: number;
  /** Lo primero que le falta. */
  missing: 'facility' | 'units' | 'contract';
}

/** Trabajo asignado a cada super admin. */
export interface AdminTodayWorkloadDto {
  superAdminId: string;
  name: string;
  tickets: number;
  followups: number;
}

/** Aviso apartado por el equipo. */
export interface AdminTodaySnoozeDto {
  id: string;
  kind: string;
  ref: string;
  label: string | null;
  until: string;
}

/** Lo que el equipo ha cerrado hoy. */
export interface AdminTodayDoneDto {
  ticketsAnswered: number;
  followupsDone: number;
  actions: { id: string; at: string; action: string; adminName: string | null }[];
}

export interface AdminTodayDto {
  date: string;
  /** Progreso de los objetivos del negocio (null si no hay ninguno). */
  businessGoals: AdminBusinessGoalsDto | null;
  addonCharges: AdminAddonChargeDueDto[];
  /** Renovaciones de pago manual que vencen en <=7 dias (Stripe renueva solo). */
  manualRenewalsDue: AdminManualRenewalDueDto[];
  trialsExpiring: AdminAtRiskTenantDto[];
  pastDue: AdminAtRiskTenantDto[];
  followupsDue: TenantFollowupDto[];
  /** Add-ons suspendidos hace >30 dias, candidatos a quitar. */
  staleSuspendedAddons: AdminStaleSuspendedAddonDto[];
  /** Tickets de soporte esperando respuesta del admin (status open). */
  openTickets: AdminOpenTicketDto[];
  /** Tenants con entregas de webhook fallidas en los últimos 7 días. */
  failedWebhooks: AdminFailedWebhooksDto[];
  /** Trabajos de las colas que han fallado en las últimas 24 h (→ /admin/queues). */
  failedJobs: number;
  /** Tenants con facturas rechazadas o con error en la AEAT, o pendientes >48 h. */
  aeatIssues: AdminTenantIssueCountDto[];
  /** Certificados de la AEAT que caducan en ≤30 días o ya caducados. */
  certificatesExpiring: AdminCertificateExpiringDto[];
  /** Tenants con envíos a Holded «para revisar». */
  holdedReview: AdminTenantIssueCountDto[];
  /** Tenants con cerraduras/lectores sin conexión (vistos antes y sin señal >1 h). */
  devicesOffline: AdminTenantIssueCountDto[];
  /** Tareas programadas que no se han ejecutado cuando tocaba. */
  overdueCrons: AdminCronStatusDto[];
  /** Solicitudes del rol soporte pendientes de aprobar. */
  pendingApprovals: AdminApprovalRequestDto[];
  /** Cortesías y pruebas gratis que vencen en 7 días. */
  expiringOverrides: AdminExpiringOverrideDto[];
  /** Seguimientos de los próximos 7 días. */
  followupsUpcoming: TenantFollowupDto[];
  /** Leads nuevos sin asignar a nadie (urgentes), del más antiguo al más nuevo. */
  newLeads: AdminTodayLeadDto[];
  /** Leads asignados que siguen sin respuesta pasadas 24 h (urgentes solo en «Lo mío»). */
  assignedLeads: AdminTodayLeadDto[];
  /** Cobros de la suscripción rechazados en las últimas 48 h. */
  paymentFailures: AdminTodayPaymentFailureDto[];
  /** Clientes de pago cuyo equipo no entra desde hace 14 días. */
  inactivePaying: AdminTodayInactiveDto[];
  /** Fallidos de las colas de las últimas 24 h sin revisar (los 20 más recientes). */
  failedJobsList: AdminTodayFailedJobDto[];
  /** Dinero en juego hoy. */
  moneyAtRisk: AdminTodayMoneyAtRiskDto;
  /** Plazo de respuesta de los tickets por prioridad, en horas. */
  responseTargets: Record<SupportTicketPriorityValue, number>;
  /** Seguimientos de leads de hoy o atrasados. */
  leadFollowupsDue: PlatformLeadFollowupDto[];
  /** Leads parados (sin actividad pasado el umbral de su fase); urgentes solo los de alto valor. */
  staleLeads: AdminTodayStaleLeadDto[];
  /** Dominios con el DNS listo, por activar. */
  domainsReady: AdminTodayDomainDto[];
  /** Facturas de suscripción de los últimos 90 días sin NIF o domicilio. */
  incompleteInvoices: AdminTenantIssueCountDto[];
  /** Solicitudes RGPD de inquilinos fuera de plazo. */
  rgpdOverdue: AdminTenantIssueCountDto[];
  npsNegative: AdminTodayNpsDto[];
  activationStalled: AdminTodayActivationDto[];
  workload: AdminTodayWorkloadDto[];
  snoozes: AdminTodaySnoozeDto[];
  done: AdminTodayDoneDto;
  /** Cifras del día (arriba de «Hoy»). */
  kpis: AdminTodayKpisDto;
  /** Lo que ha pasado en las últimas 48 horas. */
  activity: AdminActivityItemDto[];
  /** Secciones que no se pudieron cargar (claves de `ADMIN_TODAY_SECTION_LABELS`). */
  failedSections: string[];
  urgentCount: number;
}

/** Solo el número de urgentes (contador del menú). */
export interface AdminTodayCountDto {
  urgentCount: number;
}

/** Un tenant con N incidencias de un tipo. */
export interface AdminTenantIssueCountDto {
  tenantId: string;
  tenantName: string;
  count: number;
  /** Estaba apartado y ha empeorado: vuelve a salir con el motivo. */
  reappeared?: boolean;
  reappearedReason?: string | null;
}

export interface AdminCertificateExpiringDto {
  /** Id del certificado (un tenant puede tener el suyo y los de sus propietarios). */
  id: string;
  tenantId: string;
  tenantName: string;
  /** Propietario (plan Administrador) si el certificado es suyo. */
  ownerName: string | null;
  validTo: string;
  /** Días que faltan (≤0 = caducado). */
  daysLeft: number;
  /** Estaba apartado y ha empeorado: vuelve a salir con el motivo. */
  reappeared?: boolean;
  reappearedReason?: string | null;
}

/** Estado de una tarea programada (cron). */
export interface AdminCronStatusDto {
  name: string;
  /** api | worker */
  process: string;
  expression: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** La ejecución prevista ya pasó (con margen) y no se ha hecho. */
  overdue: boolean;
}

/** Salud de la facturación de un tenant (Veri*Factu y Holded). */
export interface AdminTenantBillingHealthDto {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  /** app | holded */
  invoicingMode: string;
  aeatRejected: number;
  aeatError: number;
  /** Enviadas hace más de 48 h y todavía pendientes de respuesta de la AEAT. */
  aeatPendingStale: number;
  holdedEnabled: boolean;
  holdedReview: number;
  certificateValidTo: string | null;
  certificateDaysLeft: number | null;
}

export interface AdminBillingIssueInvoiceDto {
  invoiceId: string;
  tenantId: string;
  tenantName: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  aeatStatus: string;
  aeatSentAt: string | null;
  /** Mensaje de la AEAT, si lo hay. */
  message: string | null;
}

export interface AdminBillingHealthDto {
  tenants: AdminTenantBillingHealthDto[];
  /** Facturas con problema (rechazadas, con error o pendientes >48 h), más recientes primero. */
  invoices: AdminBillingIssueInvoiceDto[];
}

/** Estado de cuenta del tenant para avisar de pagos pendientes en su panel. */
export interface TenantBillingStatusDto {
  /** La suscripción del plan está impagada (past_due). */
  pastDue: boolean;
  /** El plan impagado es de pago manual (sin Stripe): se regulariza por soporte. */
  planManual: boolean;
  /** Add-ons suspendidos por impago (con su feature, si tiene). */
  suspendedAddons: { name: string; feature: string | null }[];
  /** Features desactivadas por un add-on suspendido (para el FeatureGate). */
  suspendedFeatures: string[];
  /** Cuenta suspendida: el panel queda en solo lectura y los inquilinos no entran al área de clientes. */
  suspended: boolean;
  /** Con la cuenta suspendida: lo que sus inquilinos deben y no se les cobra hasta que pague (€). */
  heldAmount: number;
  /** Prueba o plan gratuito terminados sin pagar: el panel queda en solo lectura. */
  expired: boolean;
  /** Hay algo pendiente de pagar (plan o algún add-on). */
  hasIssue: boolean;
}

/** Impacto (sin aplicar) de cambiar el plan de un tenant. */
export interface AdminChangePlanPreviewDto {
  currentPlanName: string;
  currentPriceMonthly: number;
  newPlanName: string;
  newPriceMonthly: number;
  /** newPrice − currentPrice (negativo = más barato). */
  priceDelta: number;
  isDowngrade: boolean;
  newPlanActive: boolean;
  /** Extras que se dan de baja al cambiar: el plan nuevo ya los incluye o no los admite. */
  redundantAddons: { name: string; feature: string }[];
  /** Plan por trastero: trasteros de más que se cobrarán con la cuota (incluidos en el precio). */
  extraUnits: number;
  /** Recursos cuyo uso supera el límite del plan nuevo. */
  overLimits: { resource: string; used: number; limit: number }[];
  /** Paga por Stripe: el cambio se aplica también allí, con prorrateo. */
  chargedByStripe: boolean;
  /** Paga por Stripe y el plan nuevo no tiene precio en Stripe (no se podrá cambiar). */
  stripePriceMissing: boolean;
  /** Cuotas que debe: se cobrarán a la cuota del plan nuevo. */
  owedPeriods: number;
  /** Está en prueba: cambiar de plan la termina. */
  inTrial: boolean;
}

/** Dashboard financiero del SaaS: ingresos por fuente + serie mensual. */
export interface AdminFinanceProviderSliceDto {
  provider: string;
  total: number;
  count: number;
}
/** Forma de cobro agrupada para las gráficas de Finanzas. */
export type AdminFinanceSource = 'stripe' | 'sepa' | 'redsys' | 'manual';
export interface AdminFinanceMonthDto {
  month: string;
  stripe: number;
  sepa: number;
  redsys: number;
  /** Efectivo, transferencia, PayPal y otros apuntados a mano. */
  manual: number;
  /** Neto de los cobros del mes (cobrado − lo devuelto de esos cobros), con IVA. */
  total: number;
  /** Devuelto en el mes (por la fecha de la devolución), con IVA. */
  refunded: number;
}
export interface AdminFinanceOverviewDto {
  currency: string;
  /**
   * Cobrado neto en el periodo, con IVA: lo cobrado en esos meses menos lo que
   * se ha devuelto de esos cobros.
   */
  collectedTotal: number;
  /** Devuelto en el periodo (por la fecha de la devolución), con IVA. */
  refundedTotal: number;
  /** Importe de cobros con un contracargo abierto (aún no devuelto). */
  disputedTotal: number;
  /** Neto por forma de cobro. */
  bySource: Record<AdminFinanceSource, number>;
  /** MRR actual de los extras de los tenants que pagan, sin IVA. */
  addonsMrr: number;
  /** Facturado neto con IVA (sin las sustituidas; los abonos restan). */
  invoicedTotal: number;
  /** Cobros sin factura y facturas sin cobro del periodo. */
  reconciliation: AdminFinanceReconciliationDto;
  byProvider: AdminFinanceProviderSliceDto[];
  monthly: AdminFinanceMonthDto[];
  /** Los mismos meses justo antes, para comparar. */
  previous: { collectedTotal: number; refundedTotal: number; invoicedTotal: number };
  /** Los mismos meses del año pasado. */
  lastYear: { collectedTotal: number; refundedTotal: number; invoicedTotal: number };
  /** true = importes con IVA; false = sin IVA (`vat=without`). */
  vatIncluded: boolean;
  /** Asistente IA este mes: lo que pagan por él y lo que nos cuesta. */
  ai: AdminFinanceAiDto;
}

/** Lo que no cuadra entre cobros y facturas del periodo. */
export interface AdminFinanceReconciliationDto {
  /** Cobros (pagados) del periodo sin factura de suscripción. */
  paymentsWithoutInvoice: { count: number; total: number };
  /** Facturas del periodo sin un cobro asociado. */
  invoicesWithoutPayment: { count: number; total: number };
  /** Los cobros sin factura, uno a uno (los 200 más recientes). */
  payments: AdminReconciliationPaymentDto[];
  /** Las facturas sin cobro, una a una (las 200 más recientes). */
  invoices: AdminReconciliationInvoiceDto[];
}

export interface AdminFinanceAiDto {
  /** Al mes, sin IVA, por el extra del asistente y los de consultas de los tenants que pagan (€). */
  revenueMonthly: number;
  /** Coste estimado del mes en curso con la IA de la plataforma (USD). */
  costUsdThisMonth: number;
  /** Consultas del mes con la IA de la plataforma y con la clave de cada tenant. */
  queriesThisMonth: number;
  ownKeyQueriesThisMonth: number;
}

/** Analítica global de un add-on del catálogo (cross-tenant). */
export interface AdminAddonAnalyticsDto {
  addonId: string;
  name: string;
  slug: string;
  feature: string | null;
  priceMonthly: number;
  isActive: boolean;
  tenantsActive: number;
  tenantsSuspended: number;
  monthlyRevenue: number;
}

/** Un tenant en trial (para la gestión/conversión de trials). */
export interface AdminTrialDto {
  id: string;
  name: string;
  slug: string;
  planName: string | null;
  trialEndsAt: string | null;
  /**
   * Días naturales (hora de España) hasta el fin del trial: 0 = vence hoy,
   * negativo = ya venció otro día.
   */
  daysLeft: number | null;
  /** La prueba ya venció (y el cron aún no la ha cerrado). */
  expired: boolean;
  createdAt: string;
  /** Último login de algún usuario del tenant (null = nunca han accedido). */
  lastActivityAt: string | null;
  neverUsed: boolean;
  facilities: number;
  units: number;
  activeContracts: number;
}

/** Notas estratégicas + LTV del tenant (uso interno del super admin). */
export interface AdminTenantNotesDto {
  ltvTier: string | null;
  strategicNotes: string | null;
  tags: string[];
}

/** Un motivo de baja con su nº de tenants y MRR perdido. */
export interface AdminChurnReasonSliceDto {
  /** Código del motivo: capturado (price, competitor…) o inferido (voluntary, unknown). */
  reason: string;
  count: number;
  /** MRR mensual perdido (sin IVA, el último MRR de esos tenants), en la moneda de plataforma. */
  lostMrr: number;
  /** Cuántos de estos tenants tenían el motivo CAPTURADO (el resto son inferidos). */
  captured: number;
}

/** Churn de tenants agrupado por motivo, en la ventana consultada. */
export interface AdminChurnByReasonDto {
  months: number;
  totalChurned: number;
  lostMrr: number;
  slices: AdminChurnReasonSliceDto[];
}

/** Un mes proyectado de la previsión de MRR. */
export interface AdminMrrForecastPointDto {
  label: string;
  mrr: number;
}

/**
 * Previsión de MRR del SaaS: proyecta el MRR N meses a partir del histórico de
 * movimientos (NRR medio de la base + altas nuevas medias). Expone los
 * supuestos para que el modelo sea transparente.
 */
export interface AdminMrrForecastDto {
  currency: string;
  /** MRR actual (último mes con datos). */
  currentMrr: number;
  points: AdminMrrForecastPointDto[];
  assumptions: {
    /** Altas nuevas + reactivaciones medias por mes. */
    avgNewMrr: number;
    /** Net revenue retention medio (% de la base que se conserva/expande). */
    avgNrr: number | null;
    /** Nº de meses cerrados (sin el mes en curso) con datos usados para promediar. */
    basedOnMonths: number;
  };
  /** true si no hay histórico suficiente para proyectar. */
  warmingUp: boolean;
  /**
   * Menos de 3 meses cerrados con datos: no se proyecta crecimiento (la
   * previsión mantiene el MRR actual).
   */
  insufficientHistory: boolean;
  /** Menos de 6 meses cerrados: los escenarios son poco fiables. */
  shortHistory: boolean;
  /** Prudente (percentil 25), esperado (la media, `points`) y optimista (percentil 75). */
  scenarios: AdminForecastScenarioDto[];
  /** Previsiones guardadas de hace 1-3 meses frente al MRR real. */
  accuracy: AdminForecastAccuracyDto[];
}

/** Un tenant en el ranking de LTV realizado (Σ pagos de suscripción). */
export interface AdminLtvTopTenantDto {
  tenantId: string;
  name: string;
  /** Σ de todos sus pagos `paid` de suscripción. */
  totalPaid: number;
  /** Nº de pagos `paid`. */
  paymentsCount: number;
  /** Fecha del primer pago (ISO), null si desconocida. */
  firstPaidAt: string | null;
}

/** Una cohorte de ingresos: tenants dados de alta el mismo mes + su ingreso acumulado. */
export interface AdminLtvCohortDto {
  /** Etiqueta del mes de alta, p. ej. "ene 26". */
  cohortMonth: string;
  /** Nº de tenants de la cohorte (todos los dados de alta ese mes). */
  tenants: number;
  /** Ingreso acumulado de la cohorte (Σ pagos `paid` de esos tenants). */
  revenue: number;
  /** revenue / tenants. */
  revenuePerTenant: number;
}

/**
 * LTV (valor de vida del cliente) + cohortes de ingresos del SaaS, calculado a
 * partir de los pagos de suscripción (`tenant_subscription_payments` `paid`).
 * Todos los importes en la moneda de plataforma (EUR).
 */
export interface AdminLtvDto {
  currency: string;
  /** Nº de tenants con al menos un pago (cuentas pagadoras). */
  payingTenants: number;
  /**
   * LTV (modelo, sin IVA) = ARPA / churn mensual medio del MRR. `null` si no
   * hay datos suficientes (menos de 3 meses cerrados o ninguna baja de MRR).
   */
  avgLtv: number | null;
  /** Churn mensual medio del MRR (%) usado en el modelo; null sin datos. */
  avgMonthlyChurnPct: number | null;
  /** LTV realizado = Σ pagos netos / nº pagadores (valor ya cobrado, con IVA). */
  realizedLtv: number;
  /** Vida media en meses (alta → baja, o → hoy si sigue activo), mín. 1. */
  avgLifespanMonths: number;
  /** Ingreso medio mensual por cuenta que paga ahora (ARPA = MRR / que pagan, sin IVA). */
  avgArpa: number;
  /** Top tenants por LTV realizado (Σ pagos), mayor primero. */
  topTenants: AdminLtvTopTenantDto[];
  /** Cohortes de ingresos por mes de alta (más antigua → actual). */
  cohorts: AdminLtvCohortDto[];
}

/**
 * Análisis de recuperación de cobros fallidos de la suscripción SaaS: de las
 * facturas que fallaron al menos una vez, cuántas se acabaron cobrando.
 */
export interface AdminPaymentRetryAnalysisDto {
  months: number;
  /** Facturas que fallaron alguna vez en la ventana. */
  totalFailed: number;
  /** De ésas, las que luego se cobraron. */
  recovered: number;
  /** Las que siguen sin cobrarse. */
  stillFailing: number;
  recoveryRatePercent: number;
  /** Nº medio de intentos fallidos por factura. */
  avgAttempts: number;
  /** Importe pendiente de las no recuperadas. */
  amountAtRisk: number;
  /** Importe recuperado (facturas que fallaron y luego se cobraron). */
  amountRecovered: number;
  currency: string;
  /** Desglose por forma de cobro (Stripe, adeudos SEPA devueltos, Redsys automático). */
  bySource: { source: 'stripe' | 'sepa' | 'redsys'; totalFailed: number; recovered: number }[];
}

/** Cupón de descuento de plataforma (TrasterOS -> tenant). */
export interface PlatformCouponDto {
  id: string;
  code: string;
  discountType: PlatformCouponDiscountTypeValue;
  discountValue: number;
  validUntil: string | null;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
  /** Solo para estos planes (vacío = todos). */
  planIds: string[];
  /** Solo las primeras N cuotas de cada tenant (null = sin límite). */
  durationMonths: number | null;
  oncePerTenant: boolean;
  validFrom: string | null;
  /** Se puede usar al pagar con tarjeta (existe en Stripe). */
  stripeReady: boolean;
  /** Lo pueden usar los comerciales en sus propuestas. */
  salesAllowed: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Resultado de la extensión de trial por lote. */
export interface ExtendTrialsBatchResultDto {
  updated: number;
  /** Los que no se ampliaron y por qué. */
  skipped: { tenantId: string; name: string | null; reason: string }[];
}

/** Estado del correo saliente de la plataforma (panel super admin). */
export interface PlatformEmailSettingsDto {
  /** Proveedor elegido en el panel; null = el de la variable EMAIL_PROVIDER. */
  provider: 'brevo' | 'resend' | null;
  fallbackEnabled: boolean;
  /** Valor de la variable EMAIL_PROVIDER (smtp/brevo/resend). */
  envProvider: string;
  /** Qué proveedores tienen su clave de API configurada. */
  configured: { brevo: boolean; resend: boolean };
  /** Orden efectivo en el que se intentará enviar ahora mismo. */
  effectiveOrder: string[];
  /** Remitente de la plataforma (EMAIL_FROM_ADDRESS). */
  fromAddress: string;
  /**
   * Avisos de entrega (entregado / rebote / error): URL que hay que poner en
   * cada proveedor y si su secreto está configurado. La de Brevo se muestra sin
   * el token (va en `?token=<EMAIL_WEBHOOK_TOKEN>`). `lastEventAt`: último
   * aviso recibido (null = nunca: el webhook no está conectado).
   */
  deliveryWebhooks: {
    brevo: { url: string; configured: boolean; lastEventAt: string | null };
    resend: { url: string; configured: boolean; lastEventAt: string | null };
  };
}

/** Remitente guardado (null = no fijado en este nivel). */
export interface PlatformSenderDto {
  name: string | null;
  email: string | null;
  replyTo: string | null;
}

/** Remitente que se usará de verdad tras aplicar la herencia. */
export interface EffectivePlatformSenderDto {
  name: string;
  email: string;
  replyTo: string | null;
}

export interface PlatformSendersDto {
  /** Valores de las variables EMAIL_FROM_NAME / EMAIL_FROM_ADDRESS. */
  env: { name: string; email: string };
  default: PlatformSenderDto;
  categories: Record<PlatformSenderCategory, PlatformSenderDto>;
  effective: Record<'default' | PlatformSenderCategory, EffectivePlatformSenderDto>;
  /**
   * Por correo concreto: texto de `{tipo}` (cambiado o por defecto) y el
   * remitente con el que sale de verdad.
   */
  kinds: Record<
    PlatformEmailKind,
    { tipo: string; isDefault: boolean; fromName: string; fromEmail: string }
  >;
}

export interface TestEmailResultDto {
  /** Proveedor que entregó el correo (puede ser el de respaldo). */
  provider: string;
  providerMessageId: string | null;
}

/** Dominio de la cuenta Brevo de la plataforma que ya no usa ningún tenant. */
/**
 * Estado del dominio del remitente de la plataforma (`EMAIL_FROM_ADDRESS`) en
 * cada proveedor: si no está autenticado, el proveedor rechaza los correos
 * DESPUÉS de aceptarlos y la app no se entera.
 */
export type PlatformDomainProviderStatus =
  | 'authenticated'
  | 'pending'
  | 'missing'
  | 'no_key'
  | 'error';

export interface PlatformDomainStatusDto {
  domain: string;
  brevo: PlatformDomainProviderStatus;
  resend: PlatformDomainProviderStatus;
  /** Registros DNS que pide Brevo para este dominio (si se conocen). */
  brevoRecords: EmailDnsRecordDto[];
}

export interface UnusedBrevoDomainDto {
  domain: string;
  authenticated: boolean;
}

/** Estado de un correo de la plataforma en su historial. */
export type PlatformEmailLogStatus = 'sent' | 'delivered' | 'bounced' | 'failed' | 'suppressed';

/** Un correo de la plataforma (historial del super admin). */
export interface PlatformEmailLogDto {
  id: string;
  tenantId: string | null;
  tenantName: string | null;
  recipient: string;
  subject: string;
  /** Null en los correos de cuenta (llevan enlaces que dan acceso). */
  bodyText: string | null;
  kind: string | null;
  category: string | null;
  status: PlatformEmailLogStatus;
  provider: string | null;
  errorMessage: string | null;
  deliveredAt: string | null;
  /** Se guardó el HTML (se puede ver y reenviar). */
  hasHtml: boolean;
  announcementId: string | null;
  createdAt: string;
}

export interface PlatformEmailLogPageDto {
  items: PlatformEmailLogDto[];
  nextCursor: string | null;
}

/** Un ajuste del tenant visto desde el panel del super admin. */
export interface AdminTenantConfigItemDto {
  label: string;
  value: string;
  /** ok = configurado · warn = a revisar · off = desactivado o sin configurar. */
  tone: 'ok' | 'warn' | 'off';
}

export interface AdminTenantConfigSectionDto {
  key: string;
  title: string;
  items: AdminTenantConfigItemDto[];
}

/** Resumen de la configuración del tenant (solo lectura, para soporte). */
export interface AdminTenantConfigDto {
  sections: AdminTenantConfigSectionDto[];
}

/** Uso de un tenant en los últimos días (correo, IA y almacenamiento). */
export interface AdminTenantUsageRowDto {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  email: {
    sent: number;
    bounced: number;
    failed: number;
    /** Quejas de spam de sus destinatarios. */
    complaints: number;
    /** Rebotes / (enviados + rebotes), en %. null si no envió nada. */
    bounceRate: number | null;
  };
  ai: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    /** Coste estimado en USD con el precio de cada modelo (solo con la IA de la plataforma). */
    costUsd: number;
    /** Llamadas con la clave de IA propia del tenant (no nos cuestan). */
    ownKeyCalls: number;
    /** Consultas del asistente del panel este mes y su límite (null = sin el asistente). */
    queriesThisMonth: number;
    queryLimit: number | null;
    /** Lo que paga al mes por la IA: el extra del asistente y los de consultas (€). */
    revenueMonthly: number;
  };
  storage: {
    bytes: number;
    objects: number;
    measuredAt: string | null;
    /** Bytes por tipo de fichero (bucket). */
    byBucket: Record<string, number>;
  };
  planSlug: string | null;
  planName: string | null;
  status: string;
  tags: string[];
  salesRepId: string | null;
  salesRepName: string | null;
  /** Mensajes de WhatsApp (enviados y recibidos) en el periodo. */
  whatsapp: { messages: number };
  /** Coste de la IA por modelo en el periodo (solo con la IA de la plataforma). */
  aiByModel: { model: string; calls: number; costUsd: number }[];
  /**
   * Margen del tenant en los meses del periodo (cobrado sin IVA menos los costes
   * estimados de Finanzas). null si no ha pagado nada en ese tiempo.
   */
  margin: { revenue: number; costs: number; margin: number; marginPct: number | null } | null;
  /** Consumo anómalo frente a su media de los 3 meses anteriores. */
  anomalies: { kind: 'emails' | 'ai' | 'storage'; detail: string }[];
}

export interface AdminUsageDto {
  days: number;
  rows: AdminTenantUsageRowDto[];
  totals: {
    emailsSent: number;
    aiCostUsd: number;
    /** Lo que pagan al mes por la IA todos los tenants (€). */
    aiRevenueMonthly: number;
    storageBytes: number;
  };
  /**
   * Precios de la IA: los de respaldo (variables de entorno, para modelos que
   * no conocemos) y los de cada modelo usado en el periodo.
   */
  aiPricing: {
    inputPerMTokUsd: number;
    outputPerMTokUsd: number;
    models: {
      model: string;
      calls: number;
      /** false = modelo desconocido: se usa el precio de respaldo. */
      known: boolean;
      inputPerMTokUsd: number;
      outputPerMTokUsd: number;
    }[];
  };
  /** Última medición del almacenamiento (null si nunca se ha medido). */
  storageMeasuredAt: string | null;
  /** Tenants con algún consumo anómalo. */
  anomalyCount: number;
  /** Meses que cubre el margen de cada tenant. */
  marginMonths: number;
}

/** Respuesta guardada del soporte. Admite {empresa} y {nombre}. */
export interface SupportCannedResponseDto {
  id: string;
  title: string;
  body: string;
  authorName: string | null;
  updatedAt: string;
}

/** Tiempos de respuesta del soporte en un periodo. */
export interface AdminSupportStatsDto {
  days: number;
  ticketsOpened: number;
  ticketsAnswered: number;
  /** Media y mediana en minutos hasta la primera respuesta (null sin datos). */
  avgFirstResponseMinutes: number | null;
  medianFirstResponseMinutes: number | null;
  /** Media de las valoraciones del periodo y cuántas hay. */
  avgRating: number | null;
  ratedTickets: number;
  /** % de tickets respondidos en menos de 24 h. */
  answeredWithinDayPct: number | null;
  /** Tickets abiertos que siguen sin ninguna respuesta. */
  awaitingFirstResponse: number;
  /** Horas que lleva esperando el más antiguo sin respuesta. */
  oldestAwaitingHours: number | null;
}

/** Exportación completa de los datos de un tenant (Excel, enlace temporal). */
export interface TenantDataExportDto {
  url: string;
  expiresAt: string;
  fileBytes: number;
  counts: {
    facilities: number;
    units: number;
    customers: number;
    contracts: number;
    invoices: number;
    payments: number;
  };
}

/** Resumen de un vistazo de un tenant para la cabecera de su ficha. */
export interface AdminTenantSummaryDto {
  /** Lo que aporta al mes sin IVA (el MRR, como la lista): 0 si no paga. */
  effectiveMonthly: number;
  /** En prueba: lo que pagaría al mes sin IVA; null en el resto. */
  wouldPay: number | null;
  /** Fin de la prueba (solo en prueba). */
  trialEndsAt: string | null;
  planName: string | null;
  billingMode: string | null;
  billingExempt: boolean;
  /** Fin del periodo pagado (null si no paga, en prueba o se da de baja). */
  nextChargeAt: string | null;
  lastTeamLoginAt: string | null;
  activeUsers: number;
  invoiced30d: number;
  invoices30d: number;
  collected30d: number;
  overdueInvoices: number;
  overdueAmount: number;
  activeContracts: number;
  /** Ocupación de sus trasteros (null sin trasteros). */
  occupancyPct: number | null;
  openTickets: number;
  lastInteractionAt: string | null;
  nextFollowup: { title: string; dueDate: string } | null;
}

/** Tipos de evento del historial unificado de un tenant. */
export type AdminTimelineKind =
  | 'interaction'
  | 'admin_action'
  | 'impersonation'
  | 'payment'
  | 'invoice'
  | 'ticket'
  | 'email'
  | 'followup'
  | 'milestone';

/** Un evento del historial del tenant (de cualquier origen). */
export interface AdminTimelineItemDto {
  /** Id estable: `<tipo>:<id>`. */
  id: string;
  kind: AdminTimelineKind;
  at: string;
  title: string;
  detail: string | null;
  /** Quién lo hizo (super admin), si aplica. */
  actor: string | null;
  /** Enlace interno del panel admin, si lo hay. */
  link: string | null;
  /** Para colorear: ok / aviso / problema. */
  tone: 'neutral' | 'positive' | 'warning' | 'negative';
  /** Conversación fijada arriba del historial. */
  pinned?: boolean;
}

export interface AdminTimelinePageDto {
  items: AdminTimelineItemDto[];
  /** ISO: pasa como `before` para la página siguiente. */
  nextBefore: string | null;
  /** Nota fijada arriba (solo en la primera página). */
  pinned?: AdminTimelineItemDto | null;
}

/** Avisos por chat del panel admin (sin secretos). */
export interface ChatAlertSettingsDto {
  telegramConfigured: boolean;
  telegramChatId: string | null;
  slackConfigured: boolean;
  /** Cada mañana, lo urgente del «Hoy» (si hay algo). */
  dailyEnabled: boolean;
  /** Los lunes, el resumen semanal de KPIs. */
  weeklyEnabled: boolean;
  /** Al momento: altas, extras contratados o cancelados, cambios de plan, interés… */
  commercialEnabled: boolean;
}

export type ChatChannelResult = 'sent' | 'failed' | 'off';

export interface ChatAlertSendResultDto {
  sent: boolean;
  telegram: ChatChannelResult;
  slack: ChatChannelResult;
  /** Motivo si no se envió nada (`nothing_urgent`, `disabled`, `no_channel`). */
  reason: string | null;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'failed';

/** Solicitud de la cola de aprobación. */
export interface AdminApprovalRequestDto {
  id: string;
  tenantId: string;
  tenantName: string;
  action: ApprovalAction;
  /** Resumen legible de lo que se pide («Plan: pro», «30 días»…). */
  summary: string;
  payload: unknown;
  reason: string;
  status: ApprovalStatus;
  requestedByName: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Error al ejecutar la acción aprobada (status `failed`). */
  error: string | null;
  createdAt: string;
  /** Estado actual del tenant (solo en las pendientes). */
  currentState?: string | null;
  /** Lo que ha cambiado desde que se pidió (plan, estado, funciones…). */
  changedSinceRequest?: string[];
}

/** Un extra contratado, en la visión general de tenants. */
export interface AdminOverviewAddonDto {
  slug: string;
  name: string;
  /** Suspendido por impago. */
  suspended: boolean;
}

/** Una fila de la visión general de tenants (`GET /admin/tenants/overview`). */
export interface AdminTenantOverviewDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  billingExempt: boolean;
  createdAt: string;
  trialEndsAt: string | null;
  tags: string[];
  ltvTier: string | null;
  planSlug: string | null;
  planName: string | null;
  /** Estado de la suscripción (`trial`, `active`, `past_due`…). */
  subscriptionStatus: string | null;
  /** 'manual' | 'stripe' | 'sepa'. */
  billingMode: string | null;
  /**
   * Lo que aporta al mes sin IVA (plan + extras, como el MRR). 0 si no paga:
   * en prueba, exenta, solo lectura, suspendida o cancelada.
   */
  monthly: number;
  /** En prueba: lo que pagaría al mes sin IVA al acabarla; null en el resto. */
  wouldPay: number | null;
  addons: AdminOverviewAddonDto[];
  /**
   * Próximo cobro (fin del periodo pagado); null si es exenta, está en prueba,
   * no paga (plan gratuito o a 0 €), se da de baja al acabar el periodo o no
   * tiene suscripción. Puede estar en el pasado si aún no se ha marcado el impago.
   */
  nextChargeAt: string | null;
  /** Se da de baja al acabar el periodo: cuándo; null si no. */
  cancelsAt: string | null;
  /** Debe la suscripción (past_due): desde cuándo, o null. */
  overdueSince: string | null;
  /** Salud 0-100 y nivel (solo tenants activos y en prueba). */
  healthScore: number | null;
  healthLevel: AdminTenantHealthLevel | null;
  /** `activation` en las pruebas (su puntuación mide la puesta en marcha). */
  healthKind: 'health' | 'activation' | null;
  lastTeamLoginAt: string | null;
  nextFollowup: { title: string; dueDate: string } | null;
  facilities: number;
  units: number;
  activeContracts: number;
  ownerEmail: string | null;
  ownerPhone: string | null;
  /** Para buscar por NIF o email de facturación. */
  taxId: string | null;
  billingEmail: string | null;
  /** Anonimizado (RGPD). */
  anonymized: boolean;
  /** Fecha y motivo de la baja (cancelado o suspendido). */
  canceledAt: string | null;
  churnReason: string | null;
  /** Baja programada (aún operando). */
  cancelScheduledAt: string | null;
}

/** Resultado de la búsqueda global del panel admin (⌘K). */
export interface AdminSearchResultDto {
  tenants: { id: string; name: string; slug: string; status: string; match: string | null }[];
  tickets: { id: string; subject: string; status: string; tenantId: string; tenantName: string }[];
}

/** Un tenant candidato a un extra, con por qué. */
export interface AdminOpportunityCandidateDto {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  planName: string | null;
  /** Motivos legibles («Ha entrado 4 veces en Remesas SEPA», «82 inquilinos»…). */
  reasons: string[];
  /** Veces que su equipo entró en la función sin tenerla (30 días). */
  interestCount: number;
  lastInterestAt: string | null;
  /** Fecha de la última propuesta de este extra, o null. */
  lastOfferAt: string | null;
}

/** Oportunidades de venta de un extra (`GET /admin/opportunities`). */
export interface AdminAddonOpportunityDto {
  addonId: string;
  addonName: string;
  feature: string | null;
  priceMonthly: number;
  candidates: AdminOpportunityCandidateDto[];
}

export interface AdminProposeAddonResultDto {
  recipients: number;
  trialExpiresAt: string | null;
  followupId: string | null;
}

/** Cifras de arriba de «Hoy». */
export interface AdminTodayKpisDto {
  /** Lo que aportan al mes los tenants activos de pago (plan + extras, sin IVA si va +IVA). */
  mrr: number;
  /** Cobrado en los últimos 7 días. */
  collected7d: number;
  /** Cobrado en los 7 días anteriores. */
  collectedPrev7d: number;
  /** MRR guardado del mes pasado (null sin histórico). */
  mrrPrevMonth: number | null;
  /** Altas del mes pasado hasta el mismo punto del mes. */
  newPrevMonthToDate: number;
  /** Cuotas impagadas (past_due) + extras manuales sin cobrar. */
  pending: number;
  trials: number;
  suspended: number;
  newThisMonth: number;
}

export type AdminActivityKind =
  | 'signup'
  | 'churn'
  | 'plan_changed'
  | 'addon_added'
  | 'addon_removed'
  | 'addon_trial'
  | 'first_contract'
  | 'payment'
  | 'interest';

/** Algo que ha pasado con un tenant (actividad reciente de «Hoy» y avisos por chat). */
export interface AdminActivityItemDto {
  at: string;
  kind: AdminActivityKind;
  tenantId: string;
  tenantName: string;
  text: string;
  amount: number | null;
}

/** Resultado del simulador de cuota (`POST /admin/quote`). */
export interface AdminQuoteDto {
  cycle: 'monthly' | 'yearly';
  /** Líneas a precio de lista del periodo (mes o año). */
  lines: { label: string; amount: number }[];
  subtotal: number;
  couponCode: string | null;
  discount: number;
  /** Mensaje si el cupón no vale (el cálculo sigue sin él). */
  couponError: string | null;
  base: number;
  vat: number;
  total: number;
  pricesIncludeVat: boolean;
  taxRate: number;
  /** Lo que sale al mes (en anual, el total entre 12). */
  monthlyEquivalent: number;
  /** En anual: lo que se ahorra frente a pagar 12 meses. */
  yearlySaving: number | null;
  /** Extras elegidos cuya función ya incluye el plan. */
  includedAddonIds: string[];
}

/** Mensaje de TrasterOS al tenant (lo ve en Soporte → Mensajes de TrasterOS). */
export interface TenantPlatformMessageDto {
  id: string;
  kind: 'direct' | 'announcement' | 'retention';
  subject: string;
  body: string;
  /** Ticket donde responderlo (correo directo que espera respuesta). */
  ticketId: string | null;
  attachments: { name: string; mimeType: string; size: number }[];
  /** Cuándo lo abrió el tenant (null = sin leer). */
  readAt: string | null;
  createdAt: string;
}

export interface TenantPlatformMessagesPageDto {
  items: TenantPlatformMessageDto[];
  nextCursor: string | null;
  unread: number;
}

/** Vista guardada de una lista del panel admin. */
export interface AdminSavedViewDto {
  id: string;
  /** Lista a la que pertenece (`tenants`, `leads`, `sales_leads`…). */
  page: string;
  name: string;
  filters: Record<string, unknown>;
  /** Columnas visibles y orden de la lista (null = los de siempre). */
  columns?: string[] | null;
  sort?: { key: string; dir: 1 | -1 } | null;
  createdAt: string;
}

/** Lo que borraría «Anonimizar» y lo que conviene revisar antes. */
export interface AdminAnonymizePreviewDto {
  customers: number;
  users: number;
  activeContracts: number;
  /** Facturas que se conservan por obligación fiscal. */
  invoicesKept: number;
  warnings: { code: string; message: string }[];
}

/** Resultado del alta manual de un tenant. */
export interface AdminCreateTenantResultDto {
  tenantId: string;
  slug: string;
  ownerEmail: string;
  /** Si salió el correo para elegir la contraseña. */
  emailSent: boolean;
  /** Por qué no salió (dirección bloqueada…), o null. */
  emailError: string | null;
}

/** Una sesión abierta de un usuario del tenant. */
export interface AdminUserSessionDto {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  installedApp: boolean;
}

/** Resultado de consultar o reenviar una factura a la AEAT desde el admin. */
export interface AdminAeatActionResultDto {
  invoiceId: string;
  aeatStatus: string | null;
  message: string;
}

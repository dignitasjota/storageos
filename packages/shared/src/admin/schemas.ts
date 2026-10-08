import { z } from 'zod';

import { TenantFeatures } from '../features';

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

export const SuperAdminRoleEnum = z.enum(['superadmin', 'support']);
export type SuperAdminRoleValue = z.infer<typeof SuperAdminRoleEnum>;

export const SupportTicketStatusEnum = z.enum([
  'open',
  'in_progress',
  'waiting_user',
  'resolved',
  'closed',
]);
export type SupportTicketStatusValue = z.infer<typeof SupportTicketStatusEnum>;

export const SupportTicketPriorityEnum = z.enum(['low', 'normal', 'high', 'urgent']);
export type SupportTicketPriorityValue = z.infer<typeof SupportTicketPriorityEnum>;

// ============================================================================
// Super admin auth
// ============================================================================

export const SuperAdminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(120),
});
export type SuperAdminLoginInput = z.infer<typeof SuperAdminLoginSchema>;

// ============================================================================
// Super admin 2FA
// ============================================================================

export const SuperAdminTwoFactorSetupSchema = z.object({});
export type SuperAdminTwoFactorSetupInput = z.infer<typeof SuperAdminTwoFactorSetupSchema>;

export const SuperAdminTwoFactorVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Codigo de 6 digitos'),
});
export type SuperAdminTwoFactorVerifyInput = z.infer<typeof SuperAdminTwoFactorVerifySchema>;

export const SuperAdminTwoFactorDisableSchema = z.object({
  password: z.string().min(8),
});
export type SuperAdminTwoFactorDisableInput = z.infer<typeof SuperAdminTwoFactorDisableSchema>;

export const SuperAdminTwoFactorChallengeSchema = z.object({
  pendingToken: z.string().min(20),
  code: z
    .string()
    .regex(/^(\d{6}|[A-Z0-9]{4}-[A-Z0-9]{4})$/, 'TOTP 6 digitos o recovery XXXX-XXXX'),
});
export type SuperAdminTwoFactorChallengeInput = z.infer<typeof SuperAdminTwoFactorChallengeSchema>;

// ============================================================================
// Tenant admin actions
// ============================================================================

export const AdminTenantActionSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type AdminTenantActionInput = z.infer<typeof AdminTenantActionSchema>;

/**
 * Motivo de baja (churn) seleccionable al suspender/cancelar un tenant. Alimenta
 * el reporte «churn por razón». Las bajas sin motivo capturado se infieren en el
 * reporte (`nonpayment` si hubo impago, `voluntary` si no, `unknown` residual).
 */
export const ChurnReasonEnum = z.enum([
  'price',
  'missing_features',
  'business_closure',
  'competitor',
  'nonpayment',
  'other',
]);
export type ChurnReason = z.infer<typeof ChurnReasonEnum>;

/** Suspensión de un tenant con motivo de baja opcional. */
export const SuspendTenantSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  churnReason: ChurnReasonEnum.optional(),
});
export type SuspendTenantInput = z.infer<typeof SuspendTenantSchema>;

export const ExtendTrialSchema = z.object({
  days: z.number().int().positive().max(365),
  reason: z.string().trim().min(1).max(500),
});
export type ExtendTrialInput = z.infer<typeof ExtendTrialSchema>;

export const ChangePlanSchema = z.object({
  planSlug: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(1).max(500),
});
export type ChangePlanInput = z.infer<typeof ChangePlanSchema>;

/** Marca/desmarca un tenant como exento de facturación (cuenta interna). */
export const SetBillingExemptSchema = z.object({
  exempt: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});
export type SetBillingExemptInput = z.infer<typeof SetBillingExemptSchema>;

export const ImpersonateSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type ImpersonateInput = z.infer<typeof ImpersonateSchema>;

/** Email directo del super admin a un tenant (a sus owners / email de facturación). */
export const AdminEmailTenantSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
});
export type AdminEmailTenantInput = z.infer<typeof AdminEmailTenantSchema>;

/**
 * Playbook de retención (1 clic): crea un seguimiento, envía un email de
 * retención al owner y registra la gestión como interacción. La nota es
 * opcional (se anexa al seguimiento y al registro).
 */
export const RetentionPlaybookSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});
export type RetentionPlaybookInput = z.infer<typeof RetentionPlaybookSchema>;

/** Público de un anuncio/broadcast. */
export const AdminBroadcastAudienceEnum = z.enum(['active', 'trial', 'all']);
export type AdminBroadcastAudienceValue = z.infer<typeof AdminBroadcastAudienceEnum>;

/** Anuncio masivo del super admin a los tenants. */
export const AdminBroadcastSchema = z.object({
  audience: AdminBroadcastAudienceEnum,
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
  /** Segmentación opcional: restringe (AND con `audience`) a los tenants con esta etiqueta. */
  tag: z.string().trim().min(1).max(40).optional(),
});
export type AdminBroadcastInput = z.infer<typeof AdminBroadcastSchema>;

/** Edición de datos básicos del tenant desde el panel super admin (soporte). */
export const AdminUpdateTenantSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    billingEmail: z.string().trim().email().max(320).nullable().optional(),
    country: z.string().trim().length(2).toUpperCase().optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    taxId: z.string().trim().max(40).nullable().optional(),
    billingLegalName: z.string().trim().max(200).nullable().optional(),
    billingAddress: z.string().trim().max(300).nullable().optional(),
    billingCity: z.string().trim().max(120).nullable().optional(),
    billingPostalCode: z.string().trim().max(20).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nada que actualizar' });
export type AdminUpdateTenantInput = z.infer<typeof AdminUpdateTenantSchema>;

// ============================================================================
// Tenant interactions (histórico de conversaciones del super admin con el tenant)
// ============================================================================

export const TenantInteractionTypeEnum = z.enum([
  'note',
  'call',
  'email',
  'meeting',
  'whatsapp',
  'support',
  'other',
]);
export type TenantInteractionTypeValue = z.infer<typeof TenantInteractionTypeEnum>;

export const CreateTenantInteractionSchema = z.object({
  type: TenantInteractionTypeEnum.default('note'),
  content: z.string().trim().min(1).max(5000),
  /** Cuándo ocurrió la conversación (ISO). Por defecto, ahora. */
  occurredAt: z.string().datetime().optional(),
});
export type CreateTenantInteractionInput = z.infer<typeof CreateTenantInteractionSchema>;

export const TenantFollowupStatusEnum = z.enum(['pending', 'done']);
export type TenantFollowupStatusValue = z.infer<typeof TenantFollowupStatusEnum>;

/** Crear un seguimiento/recordatorio sobre un tenant. */
export const CreateTenantFollowupSchema = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).optional(),
  /** Fecha de recordatorio (YYYY-MM-DD). */
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)'),
});
export type CreateTenantFollowupInput = z.infer<typeof CreateTenantFollowupSchema>;

/** Cambia el estado de un seguimiento (hecho / reabrir). */
export const UpdateTenantFollowupSchema = z.object({
  status: TenantFollowupStatusEnum,
});
export type UpdateTenantFollowupInput = z.infer<typeof UpdateTenantFollowupSchema>;

// ============================================================================
// Support tickets
// ============================================================================

export const CreateSupportTicketSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
  priority: SupportTicketPriorityEnum.default('normal'),
  category: optionalText(80),
});
export type CreateSupportTicketInput = z.infer<typeof CreateSupportTicketSchema>;

export const AddTicketMessageSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  isInternal: z.boolean().default(false),
});
export type AddTicketMessageInput = z.infer<typeof AddTicketMessageSchema>;

export const TransitionTicketSchema = z.object({
  status: SupportTicketStatusEnum,
});
export type TransitionTicketInput = z.infer<typeof TransitionTicketSchema>;

export const AssignTicketSchema = z.object({
  superAdminId: z.string().uuid().nullable(),
});
export type AssignTicketInput = z.infer<typeof AssignTicketSchema>;

// ============================================================================
// SaaS billing
// ============================================================================

/** Ciclo de facturación de la suscripción SaaS (mensual o anual con descuento). */
export const BillingCycleEnum = z.enum(['monthly', 'yearly']);
export type BillingCycle = z.infer<typeof BillingCycleEnum>;

export const CreateCheckoutSessionSchema = z.object({
  planId: z.string().uuid(),
  billingCycle: BillingCycleEnum.default('monthly'),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});
export type CreateCheckoutSessionInput = z.infer<typeof CreateCheckoutSessionSchema>;

export const CreatePortalSessionSchema = z.object({
  returnUrl: z.string().url(),
});
export type CreatePortalSessionInput = z.infer<typeof CreatePortalSessionSchema>;

/** Cambio de plan self-service del tenant (upgrade/downgrade). */
export const SelfChangePlanSchema = z.object({
  planId: z.string().uuid(),
  billingCycle: BillingCycleEnum.default('monthly'),
});
export type SelfChangePlanInput = z.infer<typeof SelfChangePlanSchema>;

/**
 * Origen de un pago de la suscripción SaaS de un tenant. `stripe` lo rellena
 * el webhook automático; el resto se registran a mano desde el panel admin.
 */
export const SaasPaymentProviderEnum = z.enum([
  'stripe',
  'paypal',
  'cash',
  'bank_transfer',
  'other',
  'sepa',
]);
export type SaasPaymentProviderValue = z.infer<typeof SaasPaymentProviderEnum>;

/**
 * Modo de cobro de la suscripción de un tenant. 'stripe' solo se alcanza vía
 * el Checkout (webhook); `setBillingMode` únicamente acepta 'manual'/'sepa'
 * como destino explícito.
 */
export const SubscriptionBillingModeEnum = z.enum(['manual', 'stripe', 'sepa']);
export type SubscriptionBillingMode = z.infer<typeof SubscriptionBillingModeEnum>;

/** Cambia el modo de cobro de la suscripción de un tenant (admin). */
export const SetSubscriptionBillingModeSchema = z.object({
  mode: z.enum(['manual', 'sepa']),
});
export type SetSubscriptionBillingModeInput = z.infer<typeof SetSubscriptionBillingModeSchema>;

/**
 * Registro manual de un pago de la suscripción (efectivo/transferencia/PayPal/…).
 * Extiende el periodo de la suscripción `durationMonths` meses, igual que un
 * cobro de Stripe. La duración la propone el panel (importe ÷ precio del plan)
 * pero el admin puede editarla.
 */
export const CreateManualSaasPaymentSchema = z.object({
  provider: SaasPaymentProviderEnum,
  amount: z.number().positive().max(1_000_000),
  /** Descuento aplicado sobre el precio de lista (informativo). */
  discount: z.number().nonnegative().max(1_000_000).optional(),
  currency: z.string().trim().length(3).toUpperCase().default('EUR'),
  /** Meses que cubre el pago; extiende el periodo (si `extendsPeriod`). */
  durationMonths: z.number().int().min(1).max(36),
  /**
   * `true` (default): pago de la suscripción -> extiende el periodo. `false`:
   * cobro puntual (p. ej. un add-on de un tenant que paga el plan por Stripe) ->
   * registra el ingreso SIN tocar el periodo.
   */
  extendsPeriod: z.boolean().default(true),
  /** Fecha del cobro (ISO). Por defecto, ahora. */
  paidAt: z.string().datetime().optional(),
  description: z.string().trim().max(500).optional(),
  /**
   * Código de cupón de plataforma opcional. Si viene, el backend valida el
   * cupón, calcula el descuento (server-side, no se confía en el cliente),
   * lo registra en el pago e incrementa el uso del cupón.
   */
  couponCode: z.string().trim().min(1).max(60).optional(),
});
export type CreateManualSaasPaymentInput = z.infer<typeof CreateManualSaasPaymentSchema>;

// ============================================================================
// Cupones de plataforma (TrasterOS -> tenant): descuento del cobro SaaS
// ============================================================================

export const PlatformCouponDiscountTypeEnum = z.enum(['percentage', 'fixed']);
export type PlatformCouponDiscountTypeValue = z.infer<typeof PlatformCouponDiscountTypeEnum>;

export const CreatePlatformCouponSchema = z.object({
  code: z.string().trim().min(2).max(60).toUpperCase(),
  discountType: PlatformCouponDiscountTypeEnum,
  /** % (percentage) o importe fijo en la divisa del pago (fixed). */
  discountValue: z.number().positive().max(1_000_000),
  /** Caduca en (ISO). Sin valor = no caduca. */
  validUntil: z.string().datetime().nullable().optional(),
  /** Usos máximos. Sin valor = ilimitado. */
  maxUses: z.number().int().positive().max(1_000_000).nullable().optional(),
  isActive: z.boolean().default(true),
});
export type CreatePlatformCouponInput = z.infer<typeof CreatePlatformCouponSchema>;

export const UpdatePlatformCouponSchema = z
  .object({
    discountType: PlatformCouponDiscountTypeEnum,
    discountValue: z.number().positive().max(1_000_000),
    validUntil: z.string().datetime().nullable(),
    maxUses: z.number().int().positive().max(1_000_000).nullable(),
    isActive: z.boolean(),
  })
  .partial();
export type UpdatePlatformCouponInput = z.infer<typeof UpdatePlatformCouponSchema>;

/** Extensión de trial a VARIOS tenants a la vez. */
export const ExtendTrialsBatchSchema = z.object({
  tenantIds: z.array(z.string().uuid()).min(1).max(500),
  days: z.number().int().positive().max(365),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ExtendTrialsBatchInput = z.infer<typeof ExtendTrialsBatchSchema>;

// ============================================================================
// Security events (Fase 11A.1)
// ============================================================================

export const SecurityEventTypeEnum = z.enum([
  'login_failed_email_not_found',
  'login_failed_tenant_not_found',
  'login_failed_wrong_password',
  'login_failed_throttled',
  'register_throttled',
  'password_reset_throttled',
  'invitation_token_invalid',
  'refresh_token_reuse',
]);
export type SecurityEventTypeValue = z.infer<typeof SecurityEventTypeEnum>;

export const ListSecurityEventsSchema = z.object({
  eventType: SecurityEventTypeEnum.optional(),
  emailAttempted: z.string().trim().toLowerCase().max(320).optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListSecurityEventsInput = z.infer<typeof ListSecurityEventsSchema>;

// ============================================================================
// Super admin audit logs (Fase 12A.3)
// ============================================================================

/**
 * Filtros para listar audit logs del super admin. `action` es un texto libre
 * porque añadiremos nuevos prefijos (admin.*) con el tiempo y no queremos
 * tener que tocar el schema cada vez. La validacion fuerte vive en el
 * service: cualquier string se acepta como filtro.
 */
export const ListSuperAdminAuditLogsSchema = z.object({
  superAdminId: z.string().uuid().optional(),
  action: z.string().trim().min(1).max(120).optional(),
  targetTenantId: z.string().uuid().optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListSuperAdminAuditLogsInput = z.infer<typeof ListSuperAdminAuditLogsSchema>;

export const UpsertSubscriptionPlanSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug invalido'),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  priceMonthly: z.number().nonnegative().max(1_000_000),
  priceYearly: z.number().nonnegative().max(10_000_000),
  currency: z.string().trim().length(3).default('EUR'),
  features: z.record(z.unknown()).default({}),
  tenantFeatures: z.array(z.enum(TenantFeatures)).default([]),
  stripePriceId: z.string().trim().max(120).nullable().optional(),
  stripePriceIdYearly: z.string().trim().max(120).nullable().optional(),
  maxUnits: z.number().int().nonnegative().nullable().optional(),
  maxFacilities: z.number().int().nonnegative().nullable().optional(),
  maxUsers: z.number().int().nonnegative().nullable().optional(),
  isActive: z.boolean().default(true),
});
export type UpsertSubscriptionPlanFormInput = z.infer<typeof UpsertSubscriptionPlanSchema>;

// --- Overrides de feature por tenant (super admin) ---
export const SetTenantFeaturesSchema = z.object({
  overrides: z.array(z.object({ feature: z.enum(TenantFeatures), enabled: z.boolean() })),
});
export type SetTenantFeaturesInput = z.infer<typeof SetTenantFeaturesSchema>;

// --- Gestión de super admins (CRUD) ---
export const CreateSuperAdminSchema = z.object({
  email: z.string().email(),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(200),
  role: SuperAdminRoleEnum.optional(),
});
export type CreateSuperAdminInput = z.infer<typeof CreateSuperAdminSchema>;

export const SetSuperAdminActiveSchema = z.object({ isActive: z.boolean() });
export type SetSuperAdminActiveInput = z.infer<typeof SetSuperAdminActiveSchema>;

// --- Alertas proactivas de plataforma ---
export const UpdatePlatformAlertSettingsSchema = z.object({
  enabled: z.boolean(),
  alertEmail: z.string().email().nullable().or(z.literal('')),
  notifyPastDue: z.boolean(),
  notifyTrialExpiring: z.boolean(),
  trialExpiringDays: z.number().int().min(1).max(30),
  // Emails automáticos de ciclo de vida al tenant (bienvenida/trial/past_due).
  // Opcionales: son una sección de config independiente del mismo singleton, así
  // un PUT que solo toque las alertas del admin no necesita reenviarlos.
  lifecycleEnabled: z.boolean().optional(),
  sendWelcome: z.boolean().optional(),
  sendTrialReminders: z.boolean().optional(),
  sendPastDue: z.boolean().optional(),
  // Resumen semanal de KPIs por email al super admin. Opcional, misma razón.
  weeklyDigestEnabled: z.boolean().optional(),
});
export type UpdatePlatformAlertSettingsInput = z.infer<typeof UpdatePlatformAlertSettingsSchema>;

/** Datos fiscales del emisor (TrasterOS) para las facturas de suscripción. */
export const UpdatePlatformBillingSettingsSchema = z.object({
  legalName: z.string().trim().max(200).default(''),
  taxId: z.string().trim().max(40).default(''),
  address: z.string().trim().max(300).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  country: z.string().trim().length(2).default('ES'),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  taxRate: z.number().min(0).max(100).default(21),
  seriesPrefix: z.string().trim().min(1).max(20).default('SAAS'),
  enabled: z.boolean().default(false),
  /** Los precios de planes y extras incluyen el IVA (true) o son +IVA (false). Omitido = no cambia. */
  pricesIncludeVat: z.boolean().optional(),
  /**
   * Slug del tenant del negocio propio de la SL (sus facturas entran en la
   * exportación para la asesoría). Omitido = no cambia; '' = quitarlo.
   */
  ownTenantSlug: z.string().trim().max(100).optional(),
});
export type UpdatePlatformBillingSettingsInput = z.infer<
  typeof UpdatePlatformBillingSettingsSchema
>;

/** Emitir manualmente la factura de un pago de suscripción. */
export const IssuePlatformInvoiceSchema = z.object({
  paymentId: z.string().uuid(),
});

/**
 * Rectificar una factura de suscripción (va a una serie propia de rectificativas).
 * - `substitution`: la sustituye con los mismos importes y los datos fiscales
 *   actuales del tenant (corrige razón social, NIF o domicilio).
 * - `differences`: abono en negativo; `amount` (IVA incluido) para uno parcial,
 *   omitido = abono total (anula la factura).
 */
export const RectifyPlatformInvoiceSchema = z.object({
  method: z.enum(['substitution', 'differences']),
  /** R4 «resto de causas» (habitual) o R1 «error fundado en derecho / art. 80 LIVA». */
  rectificationType: z.enum(['R1', 'R4']).default('R4'),
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
  amount: z.number().positive().max(1_000_000).optional(),
});
export type RectifyPlatformInvoiceInput = z.infer<typeof RectifyPlatformInvoiceSchema>;

/** Config del dunning del SaaS. */
export const UpdatePlatformDunningSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    reminder1Days: z.number().int().min(0).max(365).default(3),
    reminder2Days: z.number().int().min(0).max(365).default(10),
    suspendDays: z.number().int().min(1).max(365).default(21),
  })
  .refine((v) => v.reminder1Days <= v.reminder2Days && v.reminder2Days <= v.suspendDays, {
    message: 'Los días deben ir en orden: recordatorio 1 ≤ recordatorio 2 ≤ suspensión',
  });
export type UpdatePlatformDunningSettingsInput = z.infer<
  typeof UpdatePlatformDunningSettingsSchema
>;

/** Banner global mostrado a todos los tenants. */
export const UpdatePlatformBannerSchema = z.object({
  message: z.string().trim().max(500).default(''),
  level: z.enum(['info', 'warning', 'critical']).default('info'),
  enabled: z.boolean().default(false),
});
export type UpdatePlatformBannerInput = z.infer<typeof UpdatePlatformBannerSchema>;

/** Oferta fundador de la web de TrasterOS (sección de precios). */
export const UpdatePlatformFounderOfferSchema = z.object({
  enabled: z.boolean(),
  title: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(400),
  /** Precio tachado de la puesta en marcha (p. ej. «490€»); vacío = sin esa línea. */
  setupStrike: z.string().trim().max(30),
  /** Texto junto al precio tachado; vacío = sin esa línea. */
  setupText: z.string().trim().max(200),
});
export type UpdatePlatformFounderOfferInput = z.infer<typeof UpdatePlatformFounderOfferSchema>;

/**
 * Logo de la web de TrasterOS. Sin SVG a propósito: se sirve desde el dominio
 * de ficheros (mismo sitio que la app) y un SVG puede llevar scripts.
 */
export const PLATFORM_LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const PLATFORM_LOGO_MAX_BYTES = 1024 * 1024;
export const RequestPlatformLogoUploadSchema = z.object({
  mimeType: z.enum(PLATFORM_LOGO_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(PLATFORM_LOGO_MAX_BYTES),
});
export type RequestPlatformLogoUploadInput = z.infer<typeof RequestPlatformLogoUploadSchema>;
/** Fija el logo subido (su key) o lo quita (null = logo de la marca). */
export const SetPlatformLogoSchema = z.object({ key: z.string().max(300).nullable() });
export type SetPlatformLogoInput = z.infer<typeof SetPlatformLogoSchema>;

/** Opciones del formulario de contacto de la web de TrasterOS. */
export const CONTACT_UNITS_OPTIONS = [
  'Menos de 50',
  'De 50 a 200',
  'De 200 a 500',
  'Más de 500',
] as const;
export const CONTACT_PROFILE_OPTIONS = [
  'Tengo uno o varios locales de trasteros',
  'Gestiono trasteros o viviendas de otros propietarios',
  'Quiero alquilar viviendas además de trasteros',
  'Estoy abriendo mi primer local',
  'Otro',
] as const;

/** Ajustes del formulario de contacto (panel admin → Web de TrasterOS). */
export const UpdatePlatformContactSettingsSchema = z.object({
  enabled: z.boolean(),
  /** A dónde llegan los mensajes; vacío = el formulario no se muestra. */
  email: z.string().trim().toLowerCase().email().or(z.literal('')),
  title: z.string().trim().min(1).max(80),
  subtitle: z.string().trim().max(300),
  showPhone: z.boolean(),
  requirePhone: z.boolean(),
  showCompany: z.boolean(),
  showUnits: z.boolean(),
  showProfile: z.boolean(),
});
export type UpdatePlatformContactSettingsInput = z.infer<
  typeof UpdatePlatformContactSettingsSchema
>;

/** Envío del formulario de contacto de la web (público). */
export const SubmitPlatformContactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  company: z.string().trim().max(160).optional().or(z.literal('')),
  units: z.string().trim().max(40).optional().or(z.literal('')),
  profile: z.string().trim().max(120).optional().or(z.literal('')),
  message: z.string().trim().min(10).max(4000),
  acceptPrivacy: z.literal(true),
  /** Trampa para bots: un humano no la rellena. */
  hp: z.string().max(200).optional(),
});
export type SubmitPlatformContactInput = z.infer<typeof SubmitPlatformContactSchema>;

// --- Add-ons facturables del SaaS ---------------------------------------
export const UpsertSaasAddonSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Slug inválido (minúsculas, dígitos, guiones)')
    .min(2)
    .max(60),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  priceMonthly: z.number().min(0).max(100000),
  /** Feature que activa al asignar (slug de TenantFeature); '' = ninguna. */
  feature: z.string().trim().max(60).optional().or(z.literal('')),
  /** Capacidad que aporta el add-on (por unidad de quantity); amplía los límites del plan. */
  grantsUnits: z.number().int().min(0).max(100000).optional().nullable(),
  grantsFacilities: z.number().int().min(0).max(1000).optional().nullable(),
  grantsUsers: z.number().int().min(0).max(1000).optional().nullable(),
  isActive: z.boolean().default(true),
});
export type UpsertSaasAddonInput = z.infer<typeof UpsertSaasAddonSchema>;

export const AssignAddonSchema = z.object({
  addonId: z.string().uuid(),
  quantity: z.number().int().min(1).max(999).default(1),
  /** Precio a aplicar (céntimos→€); si se omite, el del catálogo. */
  priceMonthly: z.number().min(0).max(100000).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type AssignAddonInput = z.infer<typeof AssignAddonSchema>;

/** El tenant contrata un add-on por self-service (quantity opcional). */
export const SelfAssignAddonSchema = z.object({
  addonId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99).default(1),
});
export type SelfAssignAddonInput = z.infer<typeof SelfAssignAddonSchema>;

/** Registrar el cobro de un add-on desde la bandeja «Hoy». */
export const ChargeAddonSchema = z.object({
  provider: SaasPaymentProviderEnum.default('cash'),
});
export type ChargeAddonInput = z.infer<typeof ChargeAddonSchema>;

/** Modo de cobro de un add-on contratado. */
export const AddonBillingModeEnum = z.enum(['manual', 'stripe']);
export type AddonBillingMode = z.infer<typeof AddonBillingModeEnum>;

/** Cambiar el modo de cobro de un add-on de un tenant (manual ↔ stripe). */
export const SetAddonBillingModeSchema = z.object({
  mode: AddonBillingModeEnum,
});
export type SetAddonBillingModeInput = z.infer<typeof SetAddonBillingModeSchema>;

/** Actualiza las notas/LTV/tags de un tenant (super admin). */
export const UpdateTenantNotesSchema = z.object({
  ltvTier: z.enum(['low', 'medium', 'high', 'enterprise']).nullable().optional(),
  strategicNotes: z.string().trim().max(5000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});
export type UpdateTenantNotesInput = z.infer<typeof UpdateTenantNotesSchema>;

// --- Correo saliente de la plataforma (Brevo / Resend) ---

/** Proveedores de correo seleccionables desde el panel del super admin. */
export const PlatformEmailProviders = ['brevo', 'resend'] as const;
export const PlatformEmailProviderEnum = z.enum(PlatformEmailProviders);
export type PlatformEmailProvider = z.infer<typeof PlatformEmailProviderEnum>;

export const UpdatePlatformEmailSettingsSchema = z.object({
  /** null = usar la variable EMAIL_PROVIDER. */
  provider: PlatformEmailProviderEnum.nullable(),
  /** Si el proveedor elegido falla, reintentar con el otro. */
  fallbackEnabled: z.boolean(),
});
export type UpdatePlatformEmailSettingsInput = z.infer<typeof UpdatePlatformEmailSettingsSchema>;

/**
 * Tipos de correo de la plataforma a los tenants, cada uno con su remitente
 * opcional (si no, el común; si no, las variables EMAIL_FROM_*).
 */
export const PLATFORM_SENDER_CATEGORIES = [
  'account',
  'subscription',
  'billing',
  'admin_messages',
  'staff_notices',
] as const;
export type PlatformSenderCategory = (typeof PLATFORM_SENDER_CATEGORIES)[number];

export const PLATFORM_SENDER_LABELS: Record<
  PlatformSenderCategory,
  { label: string; description: string }
> = {
  account: {
    label: 'Cuenta',
    description: 'Verificación del email, recuperar contraseña e invitaciones a usuarios.',
  },
  subscription: {
    label: 'Suscripción',
    description: 'Bienvenida y avisos de fin de la prueba gratuita.',
  },
  billing: {
    label: 'Facturación',
    description: 'Facturas de la suscripción y avisos de pago pendiente o suspensión.',
  },
  admin_messages: {
    label: 'Mensajes del administrador',
    description: 'Los emails y anuncios que envías desde este panel.',
  },
  staff_notices: {
    label: 'Avisos al equipo del tenant',
    description: 'Contacto nuevo, reserva online, baja, incidencia e informe mensual.',
  },
};

/**
 * Cada correo concreto de la plataforma: a qué tipo (remitente) pertenece y el
 * texto por defecto de la variable `{tipo}` del nombre del remitente
 * (p. ej. «TrasterOS · {tipo}» → «TrasterOS · Factura»).
 */
export const PLATFORM_EMAIL_KINDS = [
  'verify_email',
  'password_reset',
  'invitation',
  'welcome',
  'trial_ending',
  'saas_invoice',
  'payment_pending',
  'admin_message',
  'staff_notice',
  'monthly_report',
] as const;
export type PlatformEmailKind = (typeof PLATFORM_EMAIL_KINDS)[number];

export const PLATFORM_EMAIL_KIND_INFO: Record<
  PlatformEmailKind,
  { category: PlatformSenderCategory; label: string; defaultTipo: string }
> = {
  verify_email: { category: 'account', label: 'Verificar email', defaultTipo: 'Verificación' },
  password_reset: {
    category: 'account',
    label: 'Recuperar contraseña',
    defaultTipo: 'Contraseña',
  },
  invitation: { category: 'account', label: 'Invitación a un usuario', defaultTipo: 'Invitación' },
  welcome: { category: 'subscription', label: 'Bienvenida', defaultTipo: 'Bienvenida' },
  trial_ending: {
    category: 'subscription',
    label: 'Fin de la prueba',
    defaultTipo: 'Prueba gratuita',
  },
  saas_invoice: { category: 'billing', label: 'Factura de la suscripción', defaultTipo: 'Factura' },
  payment_pending: {
    category: 'billing',
    label: 'Pago pendiente / suspensión',
    defaultTipo: 'Aviso de pago',
  },
  admin_message: {
    category: 'admin_messages',
    label: 'Email directo y anuncios',
    defaultTipo: 'Comunicado',
  },
  staff_notice: {
    category: 'staff_notices',
    label: 'Contacto, reserva, baja o incidencia',
    defaultTipo: 'Aviso',
  },
  monthly_report: {
    category: 'staff_notices',
    label: 'Informe mensual',
    defaultTipo: 'Informe mensual',
  },
};

/** Variable del nombre del remitente que se sustituye por el texto del correo. */
export const SENDER_TIPO_TOKEN = '{tipo}';

/**
 * Nombre del remitente con `{tipo}` sustituido. Con el texto vacío se quita la
 * variable y los separadores que queden sueltos («TrasterOS · {tipo}» →
 * «TrasterOS»).
 */
export function renderSenderName(template: string, tipo: string): string {
  const replaced = template.replace(/\{tipo\}/gi, tipo.trim());
  return replaced
    .replace(/\s+/g, ' ')
    .replace(/^[\s·|:\-–—,]+|[\s·|:\-–—,]+$/g, '')
    .replace(/([·|:\-–—,])\s*(?=[·|:\-–—,])/g, '')
    .trim();
}

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email('Email no válido')
  .max(254)
  .or(z.literal(''))
  .optional();

export const PlatformSenderSchema = z.object({
  /** Puede incluir `{tipo}`: se sustituye por el texto de cada correo. */
  name: z.string().trim().max(70).optional(),
  email: optionalEmail,
  replyTo: optionalEmail,
});
export type PlatformSenderInput = z.infer<typeof PlatformSenderSchema>;

export const UpdatePlatformSendersSchema = z
  .object({
    default: PlatformSenderSchema,
    account: PlatformSenderSchema.optional(),
    subscription: PlatformSenderSchema.optional(),
    billing: PlatformSenderSchema.optional(),
    admin_messages: PlatformSenderSchema.optional(),
    staff_notices: PlatformSenderSchema.optional(),
    /**
     * Texto de `{tipo}` por correo. `null` (o ausente) = el de por defecto;
     * `''` = vacío (la variable desaparece del nombre).
     */
    tipoLabels: z
      .object(
        Object.fromEntries(
          PLATFORM_EMAIL_KINDS.map((k) => [k, z.string().trim().max(30).nullable().optional()]),
        ) as Record<PlatformEmailKind, z.ZodOptional<z.ZodNullable<z.ZodString>>>,
      )
      .strict()
      .optional(),
  })
  .strict();
export type UpdatePlatformSendersInput = z.infer<typeof UpdatePlatformSendersSchema>;

export const SendTestEmailSchema = z.object({
  to: z.string().trim().email(),
});
export type SendTestEmailInput = z.infer<typeof SendTestEmailSchema>;

export const UpsertSupportCannedResponseSchema = z.object({
  title: z.string().trim().min(2).max(100),
  body: z.string().trim().min(2).max(5000),
});
export type UpsertSupportCannedResponseInput = z.infer<typeof UpsertSupportCannedResponseSchema>;

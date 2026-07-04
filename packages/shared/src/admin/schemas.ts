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

/** Público de un anuncio/broadcast. */
export const AdminBroadcastAudienceEnum = z.enum(['active', 'trial', 'all']);
export type AdminBroadcastAudienceValue = z.infer<typeof AdminBroadcastAudienceEnum>;

/** Anuncio masivo del super admin a los tenants. */
export const AdminBroadcastSchema = z.object({
  audience: AdminBroadcastAudienceEnum,
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
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

export const CreateCheckoutSessionSchema = z.object({
  planId: z.string().uuid(),
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
]);
export type SaasPaymentProviderValue = z.infer<typeof SaasPaymentProviderEnum>;

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
});
export type CreateManualSaasPaymentInput = z.infer<typeof CreateManualSaasPaymentSchema>;

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
});
export type UpdatePlatformAlertSettingsInput = z.infer<typeof UpdatePlatformAlertSettingsSchema>;

/** Datos fiscales del emisor (StorageOS) para las facturas de suscripción. */
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
});
export type UpdatePlatformBillingSettingsInput = z.infer<
  typeof UpdatePlatformBillingSettingsSchema
>;

/** Emitir manualmente la factura de un pago de suscripción. */
export const IssuePlatformInvoiceSchema = z.object({
  paymentId: z.string().uuid(),
});

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

/** Actualiza las notas/LTV/tags de un tenant (super admin). */
export const UpdateTenantNotesSchema = z.object({
  ltvTier: z.enum(['low', 'medium', 'high', 'enterprise']).nullable().optional(),
  strategicNotes: z.string().trim().max(5000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});
export type UpdateTenantNotesInput = z.infer<typeof UpdateTenantNotesSchema>;

import { z } from 'zod';

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

const positiveDecimal = z.number({ invalid_type_error: 'Debe ser un numero' }).positive().finite();

const nonNegativeDecimal = z
  .number({ invalid_type_error: 'Debe ser un numero' })
  .nonnegative()
  .finite();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

// ============================================================================
// Enums
// ============================================================================

export const InvoiceStatusEnum = z.enum([
  'draft',
  'issued',
  'paid',
  'overdue',
  'cancelled',
  'refunded',
  'partially_refunded',
]);
export type InvoiceStatusValue = z.infer<typeof InvoiceStatusEnum>;

export const VerifactuModeEnum = z.enum(['verifactu', 'no_verifactu']);
export type VerifactuModeValue = z.infer<typeof VerifactuModeEnum>;

/**
 * Tipo de factura segun spec AEAT Veri*Factu. F1 = normal, F2 = simplificada
 * (post-MVP), R1-R5 = rectificativas (RD 1619/2012 art. 13).
 */
export const InvoiceTypeEnum = z.enum(['F1', 'F2', 'R1', 'R2', 'R3', 'R4', 'R5']);
export type InvoiceTypeValue = z.infer<typeof InvoiceTypeEnum>;

/**
 * Subconjunto de `InvoiceTypeEnum` con solo los codigos rectificativos. Se
 * usa en el endpoint `POST /invoices/:id/rectify` para evitar que el usuario
 * cree algo distinto a una rectificativa via ese flujo.
 */
export const RectificationTypeEnum = z.enum(['R1', 'R2', 'R3', 'R4', 'R5']);
export type RectificationTypeValue = z.infer<typeof RectificationTypeEnum>;

export const CorrectionMethodEnum = z.enum(['by_differences', 'by_substitution']);
export type CorrectionMethodValue = z.infer<typeof CorrectionMethodEnum>;

/**
 * Justificacion para superar el limite general de 400€ en factura
 * simplificada F2 (RD 1619/2012 art. 4). Con cualquiera de estas
 * justificaciones AEAT permite hasta 3000€ total.
 */
export const SimplifiedJustificationEnum = z.enum([
  'reparation',
  'transport',
  'restaurant',
  'parking',
  'other',
]);
export type SimplifiedJustificationValue = z.infer<typeof SimplifiedJustificationEnum>;

export const AeatStatusEnum = z.enum([
  'pending',
  'accepted',
  'accepted_with_warnings',
  'rejected',
  'error',
]);
export type AeatStatusValue = z.infer<typeof AeatStatusEnum>;

export const PaymentStatusEnum = z.enum([
  'pending',
  'processing',
  'succeeded',
  'failed',
  'refunded',
  'partially_refunded',
]);
export type PaymentStatusValue = z.infer<typeof PaymentStatusEnum>;

export const PaymentMethodTypeEnum = z.enum([
  'card',
  'sepa_debit',
  'bank_transfer',
  'cash',
  'other',
]);
export type PaymentMethodTypeValue = z.infer<typeof PaymentMethodTypeEnum>;

export const PaymentGatewayProviderEnum = z.enum(['stripe', 'gocardless', 'redsys', 'manual']);
export type PaymentGatewayProviderValue = z.infer<typeof PaymentGatewayProviderEnum>;

// ============================================================================
// Redsys (TPV bancario, pasarela alojada)
// ============================================================================

export const RedsysEnvironmentEnum = z.enum(['test', 'live']);
export type RedsysEnvironmentValue = z.infer<typeof RedsysEnvironmentEnum>;

export const GoCardlessEnvironmentEnum = z.enum(['sandbox', 'live']);
export type GoCardlessEnvironmentValue = z.infer<typeof GoCardlessEnvironmentEnum>;

export const UpdateGoCardlessSettingsSchema = z.object({
  /** Access token de GoCardless. Si se omite, se conserva el existente. */
  accessToken: z.string().trim().min(10).max(200).optional(),
  /** Secret del webhook de GoCardless. Si se omite, se conserva el existente. */
  webhookSecret: z.string().trim().min(10).max(200).optional(),
  environment: GoCardlessEnvironmentEnum.default('sandbox'),
  enabled: z.boolean(),
});
export type UpdateGoCardlessSettingsInput = z.infer<typeof UpdateGoCardlessSettingsSchema>;

/** Staff: inicia el mandato GoCardless para un inquilino. */
export const GoCardlessMandateStartSchema = z.object({
  customerId: z.string().uuid(),
});
export type GoCardlessMandateStartInput = z.infer<typeof GoCardlessMandateStartSchema>;

/** Staff: completa el mandato tras la autorización. */
export const GoCardlessMandateCompleteSchema = z.object({
  customerId: z.string().uuid(),
  billingRequestId: z.string().trim().min(1).max(100),
});
export type GoCardlessMandateCompleteInput = z.infer<typeof GoCardlessMandateCompleteSchema>;

/** Portal (inquilino): completa su mandato (el customer sale del token). */
export const PortalGoCardlessMandateCompleteSchema = z.object({
  billingRequestId: z.string().trim().min(1).max(100),
});
export type PortalGoCardlessMandateCompleteInput = z.infer<
  typeof PortalGoCardlessMandateCompleteSchema
>;

export const UpdateRedsysSettingsSchema = z.object({
  merchantCode: z.string().trim().min(1).max(20),
  terminal: z.string().trim().min(1).max(3).default('1'),
  /** Clave secreta del comercio. Si se omite, se conserva la existente. */
  secretKey: z.string().trim().min(10).max(200).optional(),
  environment: RedsysEnvironmentEnum.default('test'),
  enabled: z.boolean(),
});
export type UpdateRedsysSettingsInput = z.infer<typeof UpdateRedsysSettingsSchema>;

export const DunningActionTypeEnum = z.enum([
  'email_reminder',
  'sms_reminder',
  'late_fee',
  'access_block',
  'legal_notice',
]);
export type DunningActionTypeValue = z.infer<typeof DunningActionTypeEnum>;

export const PricingRuleScopeEnum = z.enum(['unit', 'unit_type', 'facility', 'tenant']);
export type PricingRuleScopeValue = z.infer<typeof PricingRuleScopeEnum>;

export const PricingRuleTypeEnum = z.enum([
  'seasonal',
  'occupancy_based',
  'duration_discount',
  'custom',
]);
export type PricingRuleTypeValue = z.infer<typeof PricingRuleTypeEnum>;

export const PriceModifierTypeEnum = z.enum(['percentage', 'fixed']);
export type PriceModifierTypeValue = z.infer<typeof PriceModifierTypeEnum>;

export const PromotionDiscountTypeEnum = z.enum(['percentage', 'fixed', 'free_months']);
export type PromotionDiscountTypeValue = z.infer<typeof PromotionDiscountTypeEnum>;

export const DataSubjectRequestTypeEnum = z.enum([
  'access',
  'rectification',
  'erasure',
  'portability',
  'restriction',
]);
export type DataSubjectRequestTypeValue = z.infer<typeof DataSubjectRequestTypeEnum>;

// ============================================================================
// Invoice Series
// ============================================================================

export const CreateInvoiceSeriesSchema = z.object({
  code: z.string().trim().min(1).max(20).toUpperCase(),
  name: z.string().trim().min(1).max(120),
  prefix: z.string().trim().min(1).max(20),
  yearScope: z.boolean().default(true),
  facilityId: z.string().uuid().optional(),
  isDefault: z.boolean().default(false),
});
export type CreateInvoiceSeriesInput = z.infer<typeof CreateInvoiceSeriesSchema>;

export const UpdateInvoiceSeriesSchema = CreateInvoiceSeriesSchema.partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateInvoiceSeriesInput = z.infer<typeof UpdateInvoiceSeriesSchema>;

// ============================================================================
// Invoices
// ============================================================================

export const CreateInvoiceItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: positiveDecimal.default(1),
  unitPrice: positiveDecimal,
  taxRate: z.number().min(0).max(100).default(21),
  relatedContractId: z.string().uuid().optional(),
  relatedUnitId: z.string().uuid().optional(),
  periodStart: dateOnly.optional(),
  periodEnd: dateOnly.optional(),
});
export type CreateInvoiceItemInput = z.infer<typeof CreateInvoiceItemSchema>;

/**
 * Tipos de factura aceptados al CREAR via `POST /invoices`. Las
 * rectificativas (R1-R5) se emiten via endpoint dedicado
 * `POST /invoices/:id/rectify` para validar la factura original; aqui
 * solo se aceptan F1 y F2.
 */
export const CreatableInvoiceTypeEnum = z.enum(['F1', 'F2']);
export type CreatableInvoiceTypeValue = z.infer<typeof CreatableInvoiceTypeEnum>;

export const CreateInvoiceSchema = z.object({
  invoiceType: CreatableInvoiceTypeEnum.default('F1'),
  /**
   * Obligatorio en F1, opcional en F2 (factura simplificada sin
   * destinatario identificado). La validacion estricta se hace en
   * `InvoicesService.create` para devolver el codigo de error apropiado.
   */
  customerId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
  seriesId: z.string().uuid().optional(),
  issueDate: dateOnly.optional(),
  dueDate: dateOnly.optional(),
  periodStart: dateOnly.optional(),
  periodEnd: dateOnly.optional(),
  items: z.array(CreateInvoiceItemSchema).min(1, 'Al menos una linea'),
  notes: optionalText(2000),
  verifactuMode: VerifactuModeEnum.default('verifactu'),
  /**
   * Justificacion para superar el limite general de 400€ en F2. Solo
   * tiene efecto cuando `invoiceType='F2'` y el total supera 400€.
   */
  simplifiedJustification: SimplifiedJustificationEnum.optional(),
});
export type CreateInvoiceInput = z.infer<typeof CreateInvoiceSchema>;

export const UpdateInvoiceSchema = z
  .object({
    dueDate: dateOnly.optional(),
    notes: optionalText(2000),
    items: z.array(CreateInvoiceItemSchema).min(1).optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateInvoiceInput = z.infer<typeof UpdateInvoiceSchema>;

export const CancelInvoiceSchema = z.object({
  reason: optionalText(500),
});
export type CancelInvoiceInput = z.infer<typeof CancelInvoiceSchema>;

export const RefundInvoiceSchema = z.object({
  amount: positiveDecimal,
  reason: optionalText(500),
});
export type RefundInvoiceInput = z.infer<typeof RefundInvoiceSchema>;

/**
 * Item de una factura rectificativa "por diferencias": el `unitPrice` puede
 * ser negativo (el usuario introduce la diferencia respecto al original; si
 * la rectificativa reduce importes, los signos seran negativos).
 */
export const RectifyInvoiceItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().int().positive().finite().default(1),
  unitPrice: z.number().finite(),
  taxRate: z.number().min(0).max(100).default(21),
  relatedContractId: z.string().uuid().optional(),
  relatedUnitId: z.string().uuid().optional(),
  periodStart: dateOnly.optional(),
  periodEnd: dateOnly.optional(),
});
export type RectifyInvoiceItemInput = z.infer<typeof RectifyInvoiceItemSchema>;

export const RectifyInvoiceSchema = z.object({
  rectificationType: RectificationTypeEnum,
  reason: z.string().trim().min(1).max(500),
  /**
   * `by_differences` (defecto): los items son DIFERENCIAS respecto al
   * original (pueden ser negativos). El total resultante puede ser
   * positivo o negativo.
   *
   * `by_substitution`: los items representan el NUEVO total absoluto
   * que sustituye al original. Al emitir, el XML incluye un bloque
   * `<ImporteRectificacion>` con los totales originales para que AEAT
   * sepa exactamente que se sustituye.
   */
  correctionMethod: CorrectionMethodEnum.default('by_differences'),
  items: z.array(RectifyInvoiceItemSchema).min(1, 'Al menos una linea'),
  issueDate: z.string().datetime().optional(),
});
export type RectifyInvoiceInput = z.infer<typeof RectifyInvoiceSchema>;

// ============================================================================
// Payment methods + payments
// ============================================================================

export const CreateSetupIntentSchema = z.object({
  customerId: z.string().uuid(),
});
export type CreateSetupIntentInput = z.infer<typeof CreateSetupIntentSchema>;

export const RegisterPaymentMethodSchema = z.object({
  customerId: z.string().uuid(),
  type: PaymentMethodTypeEnum,
  /** En Stripe: el `payment_method` id devuelto por setupIntent. */
  gatewayToken: z.string().min(1),
  gatewayCustomerId: z.string().optional(),
  last4: z.string().length(4).optional(),
  brand: z.string().max(40).optional(),
  expMonth: z.number().int().min(1).max(12).optional(),
  expYear: z.number().int().min(2020).max(2099).optional(),
  isDefault: z.boolean().default(false),
  mandateReference: z.string().optional(),
});
export type RegisterPaymentMethodInput = z.infer<typeof RegisterPaymentMethodSchema>;

export const ChargeInvoiceSchema = z.object({
  paymentMethodId: z.string().uuid().optional(),
  /** Si no se envia importe, se cobra el total pendiente de la factura. */
  amount: positiveDecimal.optional(),
});
export type ChargeInvoiceInput = z.infer<typeof ChargeInvoiceSchema>;

export const MarkPaidManuallySchema = z.object({
  amount: positiveDecimal,
  paidAt: z.string().datetime().optional(),
  methodType: PaymentMethodTypeEnum.default('cash'),
  notes: optionalText(500),
});
export type MarkPaidManuallyInput = z.infer<typeof MarkPaidManuallySchema>;

// ============================================================================
// Pricing rules
// ============================================================================

export const CreatePricingRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scope: PricingRuleScopeEnum,
  targetId: z.string().uuid().optional(),
  ruleType: PricingRuleTypeEnum,
  conditions: z.record(z.unknown()).default({}),
  modifierType: PriceModifierTypeEnum,
  modifierValue: z.number().finite(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  priority: z.number().int().min(0).max(1000).default(0),
});
export type CreatePricingRuleInput = z.infer<typeof CreatePricingRuleSchema>;

// ============================================================================
// Promotions
// ============================================================================

const promotionCodeField = z
  .string()
  .trim()
  .toUpperCase()
  .min(3)
  .max(40)
  .regex(/^[A-Z0-9_-]+$/, 'Solo letras, números, guion y guion bajo');

export const CreatePromotionSchema = z
  .object({
    code: promotionCodeField,
    name: z.string().trim().min(1).max(120),
    discountType: PromotionDiscountTypeEnum,
    discountValue: positiveDecimal,
    appliesTo: z.record(z.unknown()).default({}),
    maxUses: z.number().int().positive().optional(),
    validFrom: z.string().datetime({ offset: true }).optional(),
    validUntil: z.string().datetime({ offset: true }).optional(),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.discountType !== 'percentage' || v.discountValue <= 100, {
    message: 'El porcentaje no puede superar 100',
    path: ['discountValue'],
  })
  .refine((v) => v.discountType !== 'free_months' || Number.isInteger(v.discountValue), {
    message: 'Los meses gratis deben ser un número entero',
    path: ['discountValue'],
  });
export type CreatePromotionInput = z.infer<typeof CreatePromotionSchema>;

export const UpdatePromotionSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    discountType: PromotionDiscountTypeEnum.optional(),
    discountValue: positiveDecimal.optional(),
    appliesTo: z.record(z.unknown()).optional(),
    maxUses: z.number().int().positive().nullable().optional(),
    validFrom: z.string().datetime({ offset: true }).nullable().optional(),
    validUntil: z.string().datetime({ offset: true }).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.discountType !== 'percentage' || v.discountValue === undefined || v.discountValue <= 100,
    { message: 'El porcentaje no puede superar 100', path: ['discountValue'] },
  );
export type UpdatePromotionInput = z.infer<typeof UpdatePromotionSchema>;

/** Previsualiza el descuento de un código sobre un precio mensual dado. */
export const ValidatePromotionSchema = z.object({
  code: z.string().trim().toUpperCase().min(1).max(40),
  monthlyPrice: z.number().nonnegative(),
});
export type ValidatePromotionInput = z.infer<typeof ValidatePromotionSchema>;

// ============================================================================
// RGPD
// ============================================================================

export const CreateDataSubjectRequestSchema = z.object({
  customerId: z.string().uuid().optional(),
  email: z.string().trim().toLowerCase().email(),
  requestType: DataSubjectRequestTypeEnum,
  notes: optionalText(2000),
});
export type CreateDataSubjectRequestInput = z.infer<typeof CreateDataSubjectRequestSchema>;

// ============================================================================
// Customer portal magic link
// ============================================================================

export const PortalRequestMagicLinkSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(3).max(63),
  email: z.string().trim().toLowerCase().email(),
});
export type PortalRequestMagicLinkInput = z.infer<typeof PortalRequestMagicLinkSchema>;

export const PortalConsumeMagicLinkSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{16,64}\.[A-Za-z0-9_-]{20,}$/, 'Token invalido'),
});
export type PortalConsumeMagicLinkInput = z.infer<typeof PortalConsumeMagicLinkSchema>;

/**
 * Registro de payment method desde el portal del inquilino. A diferencia
 * de `RegisterPaymentMethodSchema` (staff), NO acepta `customerId` ni
 * `type`: el customer sale del JWT de portal y el tipo real lo deriva el
 * backend del gateway.
 */
export const PortalRegisterPaymentMethodSchema = z.object({
  gatewayToken: z.string().min(1),
  gatewayCustomerId: z.string().optional(),
});
export type PortalRegisterPaymentMethodInput = z.infer<typeof PortalRegisterPaymentMethodSchema>;

// Re-utilizado del shared/customers
export { nonNegativeDecimal };

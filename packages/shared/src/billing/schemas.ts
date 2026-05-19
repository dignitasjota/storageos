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

export const CreateInvoiceSchema = z.object({
  customerId: z.string().uuid(),
  contractId: z.string().uuid().optional(),
  seriesId: z.string().uuid().optional(),
  issueDate: dateOnly.optional(),
  dueDate: dateOnly.optional(),
  periodStart: dateOnly.optional(),
  periodEnd: dateOnly.optional(),
  items: z.array(CreateInvoiceItemSchema).min(1, 'Al menos una linea'),
  notes: optionalText(2000),
  verifactuMode: VerifactuModeEnum.default('verifactu'),
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

export const CreatePromotionSchema = z.object({
  code: z.string().trim().toUpperCase().min(3).max(40),
  name: z.string().trim().min(1).max(120),
  discountType: PromotionDiscountTypeEnum,
  discountValue: positiveDecimal,
  appliesTo: z.record(z.unknown()).default({}),
  maxUses: z.number().int().positive().optional(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
});
export type CreatePromotionInput = z.infer<typeof CreatePromotionSchema>;

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

// Re-utilizado del shared/customers
export { nonNegativeDecimal };

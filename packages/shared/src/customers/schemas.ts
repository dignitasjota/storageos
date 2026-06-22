import { z } from 'zod';

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

const phoneSchema = z
  .string()
  .trim()
  .max(40)
  .regex(/^[+\d\s().-]+$/, 'Telefono no valido')
  .optional()
  .or(z.literal(''));

export const CustomerTypeEnum = z.enum(['individual', 'business']);
export type CustomerTypeValue = z.infer<typeof CustomerTypeEnum>;

// ============================================================================
// Customers
// ============================================================================

const customerBase = {
  customerType: CustomerTypeEnum.default('individual'),
  firstName: optionalText(100),
  lastName: optionalText(120),
  companyName: optionalText(200),
  documentType: optionalText(30),
  documentNumber: optionalText(40),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  phone: phoneSchema,
  address: optionalText(300),
  city: optionalText(120),
  postalCode: optionalText(20),
  country: z.string().trim().length(2).toUpperCase().default('ES'),
  emergencyContactName: optionalText(120),
  emergencyContactPhone: phoneSchema,
  notes: optionalText(2000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
};

export const CreateCustomerSchema = z
  .object({
    ...customerBase,
    /**
     * Código de referido (del referidor) introducido al darse de alta. Si el
     * programa está activo y el código existe, se registra el referido.
     * Best-effort: un código inválido no bloquea el alta.
     */
    referralCode: z.string().trim().toUpperCase().max(32).optional(),
  })
  .refine(
    (v) =>
      v.customerType === 'business'
        ? !!v.companyName?.trim()
        : !!v.firstName?.trim() && !!v.lastName?.trim(),
    {
      message: 'Individuales requieren nombre y apellidos; empresas requieren nombre de empresa',
      path: ['customerType'],
    },
  );
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

export const UpdateCustomerSchema = z
  .object(customerBase)
  .partial()
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;

export const SetKycVerifiedSchema = z.object({
  verified: z.boolean(),
  notes: optionalText(500),
});
export type SetKycVerifiedInput = z.infer<typeof SetKycVerifiedSchema>;

// ============================================================================
// Customer documents
// ============================================================================

export const CustomerDocumentTypeEnum = z.enum([
  'id_front',
  'id_back',
  'proof_of_address',
  'other',
]);
export type CustomerDocumentTypeValue = z.infer<typeof CustomerDocumentTypeEnum>;

export const RequestCustomerDocumentUploadSchema = z.object({
  type: CustomerDocumentTypeEnum,
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024, 'Maximo 10 MB'),
  fileName: z.string().trim().min(1).max(200),
});
export type RequestCustomerDocumentUploadInput = z.infer<
  typeof RequestCustomerDocumentUploadSchema
>;

export const RegisterCustomerDocumentSchema = z.object({
  type: CustomerDocumentTypeEnum,
  fileUrl: z.string().url(),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string(),
  fileSize: z.number().int().positive(),
  expiresAt: z.string().datetime().optional(),
});
export type RegisterCustomerDocumentInput = z.infer<typeof RegisterCustomerDocumentSchema>;

// ============================================================================
// Contracts
// ============================================================================

export const ContractStatusEnum = z.enum(['draft', 'active', 'ending', 'ended', 'cancelled']);
export type ContractStatusValue = z.infer<typeof ContractStatusEnum>;

export const ContractBillingCycleEnum = z.enum(['monthly', 'weekly', 'daily']);
export type ContractBillingCycleValue = z.infer<typeof ContractBillingCycleEnum>;

export const ContractDepositStatusEnum = z.enum(['none', 'held', 'returned', 'partially_returned']);
export type ContractDepositStatusValue = z.infer<typeof ContractDepositStatusEnum>;

export const ContractEventTypeEnum = z.enum([
  'created',
  'signed',
  'price_changed',
  'unit_changed',
  'paused',
  'resumed',
  'ending_requested',
  'ended',
  'cancelled',
  'note_added',
]);
export type ContractEventTypeValue = z.infer<typeof ContractEventTypeEnum>;

const positiveDecimal = z.number({ invalid_type_error: 'Debe ser un numero' }).positive().finite();
const nonNegativeDecimal = z
  .number({ invalid_type_error: 'Debe ser un numero' })
  .nonnegative()
  .finite();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

export const CreateContractSchema = z.object({
  customerId: z.string().uuid(),
  unitId: z.string().uuid(),
  startDate: dateOnly,
  endDate: dateOnly.optional(),
  billingCycle: ContractBillingCycleEnum.default('monthly'),
  priceMonthly: positiveDecimal,
  discountAmount: nonNegativeDecimal.default(0),
  discountReason: optionalText(200),
  /**
   * Código promocional opcional. Si se indica y es válido (percentage/fixed),
   * el backend calcula `discountAmount` (recurrente sobre la cuota) y registra
   * el uso; tiene prioridad sobre un `discountAmount` manual.
   */
  promotionCode: z.string().trim().toUpperCase().max(32).optional(),
  depositAmount: nonNegativeDecimal.default(0),
  /** Plan de seguro opcional; la prima se congela y se factura cada mes. */
  insurancePlanId: z.string().uuid().optional(),
  autoRenew: z.boolean().default(true),
  cancellationNoticeDays: z.number().int().min(0).max(365).default(15),
  notes: optionalText(2000),
});
export type CreateContractInput = z.infer<typeof CreateContractSchema>;

/** Solo se permite actualizar campos NO firmados o "meta" tras firmar. */
export const UpdateContractSchema = z
  .object({
    endDate: dateOnly.optional(),
    discountAmount: nonNegativeDecimal.optional(),
    discountReason: optionalText(200),
    autoRenew: z.boolean().optional(),
    cancellationNoticeDays: z.number().int().min(0).max(365).optional(),
    notes: optionalText(2000),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateContractInput = z.infer<typeof UpdateContractSchema>;

/** Firma del contrato por el staff (opcional: firma asistida en el local). */
export const SignContractSchema = z
  .object({
    signerName: optionalText(160),
    method: z.enum(['drawn', 'typed']).optional(),
    signatureImage: z.string().max(2_000_000).optional(),
    typedSignature: optionalText(160),
  })
  // El cuerpo es opcional: firmar sin firma manuscrita envía body vacío.
  .default({});
export type SignContractInput = z.infer<typeof SignContractSchema>;

export const ChangeContractPriceSchema = z.object({
  priceMonthly: positiveDecimal,
  reason: z.string().trim().min(1).max(500),
});
export type ChangeContractPriceInput = z.infer<typeof ChangeContractPriceSchema>;

export const AddContractNoteSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});
export type AddContractNoteInput = z.infer<typeof AddContractNoteSchema>;

export const CancelContractSchema = z.object({
  reason: optionalText(500),
});
export type CancelContractInput = z.infer<typeof CancelContractSchema>;

// ============================================================================
// Reservations
// ============================================================================

export const ReservationStatusEnum = z.enum([
  'pending',
  'confirmed',
  'expired',
  'converted',
  'cancelled',
]);
export type ReservationStatusValue = z.infer<typeof ReservationStatusEnum>;

export const CreateReservationSchema = z
  .object({
    unitId: z.string().uuid(),
    customerId: z.string().uuid().optional(),
    validFrom: z.string().datetime(),
    validUntil: z.string().datetime(),
    depositAmount: nonNegativeDecimal.default(0),
    notes: optionalText(1000),
  })
  .refine((v) => new Date(v.validUntil).getTime() > new Date(v.validFrom).getTime(), {
    message: '`validUntil` debe ser posterior a `validFrom`',
    path: ['validUntil'],
  });
export type CreateReservationInput = z.infer<typeof CreateReservationSchema>;

export const CancelReservationSchema = z.object({
  reason: optionalText(500),
});
export type CancelReservationInput = z.infer<typeof CancelReservationSchema>;

export const ConvertReservationSchema = z.object({
  /** Datos para crear el contrato. Si no se envia `customerId`, se usa el
   *  de la reserva (debe estar presente). */
  customerId: z.string().uuid().optional(),
  startDate: dateOnly,
  endDate: dateOnly.optional(),
  priceMonthly: positiveDecimal,
  discountAmount: nonNegativeDecimal.default(0),
  discountReason: optionalText(200),
  depositAmount: nonNegativeDecimal.default(0),
  billingCycle: ContractBillingCycleEnum.default('monthly'),
});
export type ConvertReservationInput = z.infer<typeof ConvertReservationSchema>;

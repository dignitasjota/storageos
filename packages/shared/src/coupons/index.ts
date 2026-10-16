import { z } from 'zod';

/**
 * Cupones: descuento sobre el pago que se hace en ese momento (el primer pago
 * del contrato, de 1 a 12 meses por adelantado). Las renovaciones van al
 * precio normal. Distintos de las promociones del alta de contrato, que
 * descuentan todas las cuotas.
 *
 * Los importes son sin IVA, como el precio del trastero. La fianza y el seguro
 * nunca se descuentan.
 */

export const CouponDiscountTypeEnum = z.enum(['percentage', 'fixed', 'free_months']);
export type CouponDiscountType = z.infer<typeof CouponDiscountTypeEnum>;

export const COUPON_DISCOUNT_TYPE_LABELS: Record<CouponDiscountType, string> = {
  percentage: 'Porcentaje',
  fixed: 'Importe fijo',
  free_months: 'Meses gratis',
};

/** Meses que se pueden pagar por adelantado con un cupón. */
export const COUPON_MAX_MONTHS = 12;

/** Meses que se pueden elegir para el primer pago de un contrato. */
export const FIRST_PAYMENT_MONTHS = [1, 3, 6, 12] as const;
export type FirstPaymentMonths = (typeof FIRST_PAYMENT_MONTHS)[number];
export const FirstPaymentMonthsSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(6),
  z.literal(12),
]);

const couponCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(3)
  .max(40)
  .regex(/^[A-Z0-9_-]+$/, 'Solo letras, números, guion y guion bajo');

const isoDate = z.string().datetime({ offset: true });

const couponFields = {
  name: z.string().trim().min(1).max(120),
  discountType: CouponDiscountTypeEnum,
  discountValue: z.number().positive().max(100_000),
  minMonths: z.number().int().min(1).max(COUPON_MAX_MONTHS),
  minAmount: z.number().positive().max(1_000_000).nullable(),
  unitTypeIds: z.array(z.string().uuid()).max(100),
  facilityIds: z.array(z.string().uuid()).max(100),
  newCustomersOnly: z.boolean(),
  maxUses: z.number().int().positive().nullable(),
  validFrom: isoDate.nullable(),
  validUntil: isoDate.nullable(),
  isActive: z.boolean(),
};

type CouponRuleFields = {
  discountType?: CouponDiscountType | undefined;
  discountValue?: number | undefined;
  minMonths?: number | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
};

/** Reglas que dependen de varios campos (también al editar, sobre el resultado). */
export function couponRuleIssues(v: CouponRuleFields): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (v.discountType === 'percentage' && v.discountValue !== undefined && v.discountValue > 100) {
    issues.push({ path: 'discountValue', message: 'El porcentaje no puede superar 100' });
  }
  if (v.discountType === 'free_months' && v.discountValue !== undefined) {
    if (!Number.isInteger(v.discountValue)) {
      issues.push({
        path: 'discountValue',
        message: 'Los meses gratis deben ser un número entero',
      });
    } else if (v.minMonths !== undefined && v.minMonths <= v.discountValue) {
      issues.push({
        path: 'minMonths',
        message: 'Los meses mínimos deben ser más que los meses gratis (se paga al menos uno)',
      });
    }
  }
  if (v.validFrom && v.validUntil && new Date(v.validFrom) >= new Date(v.validUntil)) {
    issues.push({
      path: 'validUntil',
      message: 'La fecha de fin debe ser posterior a la de inicio',
    });
  }
  return issues;
}

export const CreateCouponSchema = z
  .object({
    code: couponCode,
    ...couponFields,
    minMonths: couponFields.minMonths.default(1),
    minAmount: couponFields.minAmount.default(null),
    unitTypeIds: couponFields.unitTypeIds.default([]),
    facilityIds: couponFields.facilityIds.default([]),
    newCustomersOnly: couponFields.newCustomersOnly.default(false),
    maxUses: couponFields.maxUses.default(null),
    validFrom: couponFields.validFrom.default(null),
    validUntil: couponFields.validUntil.default(null),
    isActive: couponFields.isActive.default(true),
  })
  .superRefine((v, ctx) => {
    for (const i of couponRuleIssues(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i.path], message: i.message });
    }
  });
export type CreateCouponInput = z.infer<typeof CreateCouponSchema>;

/** El código no se cambia (ya puede estar repartido); para otro, otro cupón. */
export const UpdateCouponSchema = z.object({
  name: couponFields.name.optional(),
  discountType: couponFields.discountType.optional(),
  discountValue: couponFields.discountValue.optional(),
  minMonths: couponFields.minMonths.optional(),
  minAmount: couponFields.minAmount.optional(),
  unitTypeIds: couponFields.unitTypeIds.optional(),
  facilityIds: couponFields.facilityIds.optional(),
  newCustomersOnly: couponFields.newCustomersOnly.optional(),
  maxUses: couponFields.maxUses.optional(),
  validFrom: couponFields.validFrom.optional(),
  validUntil: couponFields.validUntil.optional(),
  isActive: couponFields.isActive.optional(),
});
export type UpdateCouponInput = z.infer<typeof UpdateCouponSchema>;

export interface CouponDto {
  id: string;
  code: string;
  name: string;
  discountType: CouponDiscountType;
  discountValue: number;
  minMonths: number;
  minAmount: number | null;
  unitTypeIds: string[];
  facilityIds: string[];
  newCustomersOnly: boolean;
  maxUses: number | null;
  usedCount: number;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface CouponRedemptionDto {
  id: string;
  customerId: string | null;
  customerName: string | null;
  contractId: string | null;
  contractNumber: string | null;
  invoiceId: string | null;
  months: number;
  discountAmount: number;
  freeMonths: number;
  createdAt: string;
}

/** Comprueba un cupón para un trastero y un número de meses (panel). */
export const ValidateCouponSchema = z.object({
  code: z.string().trim().toUpperCase().min(1).max(40),
  unitId: z.string().uuid(),
  months: z.number().int().min(1).max(COUPON_MAX_MONTHS),
  /** Cuota pactada sin IVA; sin ella, el precio del trastero. */
  monthlyPrice: z.number().nonnegative().optional(),
  /** Para «solo clientes nuevos». Sin él, se da por nuevo. */
  customerId: z.string().uuid().optional(),
});
export type ValidateCouponInput = z.infer<typeof ValidateCouponSchema>;

/** Lo que paga el cliente al contratar (resumen antes de reservar o firmar). */
export interface FirstPaymentQuoteDto {
  months: number;
  /** Cuota mensual sin IVA. */
  monthlyPrice: number;
  /** IVA del alquiler (21 % trastero, 0 % vivienda). */
  vatRate: number;
  /** Alquiler de los meses sin cupón, sin IVA. */
  rentSubtotal: number;
  /** Descuento del cupón, sin IVA. */
  discountAmount: number;
  freeMonths: number;
  /** Alquiler con el cupón, sin IVA. */
  rentTotal: number;
  /** Alquiler con el cupón, IVA incluido. */
  rentTotalWithVat: number;
  /** Seguro/protección de los mismos meses, IVA incluido (sin descuento). */
  insuranceWithVat: number;
  /** Fianza (sin IVA, se devuelve al terminar). */
  deposit: number;
  /** Total a pagar ahora: alquiler + seguro con IVA + fianza. */
  totalToPay: number;
  /**
   * Sin cupón y pagando un mes, la 1ª factura va del alta a fin de mes
   * (prorrateada): el importe real puede ser menor.
   */
  prorated: boolean;
  /** Cupón indicado: si vale y, si no, por qué. */
  coupon: { code: string; name: string | null; valid: boolean; message: string | null } | null;
}

/** Resumen del primer pago en la reserva online (antes de crearla). */
export const BookingQuoteSchema = z.object({
  facilityId: z.string().uuid(),
  unitTypeId: z.string().uuid(),
  months: FirstPaymentMonthsSchema.default(1),
  couponCode: z.string().trim().toUpperCase().max(40).optional().or(z.literal('')),
  /** Para «solo clientes nuevos». */
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
});
export type BookingQuoteInput = z.infer<typeof BookingQuoteSchema>;

/** Resumen del primer pago en el portal (trastero adicional). */
export const PortalUnitQuoteSchema = z.object({
  months: FirstPaymentMonthsSchema.default(1),
  couponCode: z.string().trim().toUpperCase().max(40).optional().or(z.literal('')),
});
export type PortalUnitQuoteInput = z.infer<typeof PortalUnitQuoteSchema>;

// ============================================================================
// Cálculo
// ============================================================================

export type CouponRejectReason =
  | 'not_found'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'max_uses_reached'
  | 'invalid_months'
  | 'min_months'
  | 'min_amount'
  | 'unit_type'
  | 'facility'
  | 'new_customers_only';

/** Lo que necesita el cálculo del cupón (importes en euros, sin IVA). */
export interface CouponRules {
  discountType: CouponDiscountType;
  discountValue: number;
  minMonths: number;
  minAmount: number | null;
  unitTypeIds: string[];
  facilityIds: string[];
  newCustomersOnly: boolean;
  maxUses: number | null;
  usedCount: number;
  validFrom: Date | string | null;
  validUntil: Date | string | null;
  isActive: boolean;
}

export interface CouponQuoteContext {
  /** Cuota mensual del trastero, sin IVA. */
  monthlyPrice: number;
  /** Meses que se pagan ahora. */
  months: number;
  unitTypeId?: string | null | undefined;
  facilityId?: string | null | undefined;
  /** Si es un cliente nuevo; sin dato se da por nuevo. */
  isNewCustomer?: boolean | null | undefined;
  now?: Date;
}

export type CouponQuote =
  | {
      valid: true;
      months: number;
      /** Alquiler del periodo sin cupón (sin IVA). */
      rentSubtotal: number;
      /** Lo que descuenta el cupón (sin IVA). */
      discountAmount: number;
      /** Meses regalados (solo free_months). */
      freeMonths: number;
      /** Alquiler del periodo con el cupón (sin IVA). */
      rentTotal: number;
    }
  | { valid: false; reason: CouponRejectReason; message: string };

export type CouponQuoteDto = CouponQuote & { code: string; name: string | null };

const toDate = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));
const cents = (euros: number): number => Math.round(euros * 100);
const eur = (n: number): string =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} €`;

/** Mensaje para el cliente cuando el cupón no vale. */
export function couponRejectMessage(reason: CouponRejectReason, rules?: CouponRules): string {
  switch (reason) {
    case 'not_found':
      return 'Este cupón no existe';
    case 'inactive':
      return 'Este cupón no está activo';
    case 'not_started':
      return 'Este cupón aún no se puede usar';
    case 'expired':
      return 'Este cupón ha caducado';
    case 'max_uses_reached':
      return 'Este cupón ya se ha usado el máximo de veces';
    case 'invalid_months':
      return `Elige entre 1 y ${COUPON_MAX_MONTHS} meses`;
    case 'min_months': {
      const n = rules?.minMonths ?? 1;
      return `Este cupón es a partir de ${n} ${n === 1 ? 'mes' : 'meses'} pagados por adelantado`;
    }
    case 'min_amount':
      return rules?.minAmount
        ? `Este cupón es para pagos a partir de ${eur(rules.minAmount)} (sin IVA)`
        : 'El importe no llega al mínimo de este cupón';
    case 'unit_type':
      return 'Este cupón no vale para este tamaño de trastero';
    case 'facility':
      return 'Este cupón no vale en este local';
    case 'new_customers_only':
      return 'Este cupón es solo para clientes nuevos';
  }
}

/**
 * Calcula el descuento de un cupón sobre el pago de `months` meses. Todo en
 * céntimos para no arrastrar decimales.
 */
export function quoteCoupon(rules: CouponRules, ctx: CouponQuoteContext): CouponQuote {
  const reject = (reason: CouponRejectReason): CouponQuote => ({
    valid: false,
    reason,
    message: couponRejectMessage(reason, rules),
  });
  const now = ctx.now ?? new Date();
  const from = toDate(rules.validFrom);
  const until = toDate(rules.validUntil);
  if (!rules.isActive) return reject('inactive');
  if (from && from > now) return reject('not_started');
  if (until && until < now) return reject('expired');
  if (rules.maxUses !== null && rules.usedCount >= rules.maxUses) return reject('max_uses_reached');
  if (!Number.isInteger(ctx.months) || ctx.months < 1 || ctx.months > COUPON_MAX_MONTHS) {
    return reject('invalid_months');
  }
  if (ctx.months < rules.minMonths) return reject('min_months');
  if (
    rules.unitTypeIds.length > 0 &&
    !(ctx.unitTypeId && rules.unitTypeIds.includes(ctx.unitTypeId))
  ) {
    return reject('unit_type');
  }
  if (
    rules.facilityIds.length > 0 &&
    !(ctx.facilityId && rules.facilityIds.includes(ctx.facilityId))
  ) {
    return reject('facility');
  }
  if (rules.newCustomersOnly && ctx.isNewCustomer === false) return reject('new_customers_only');

  const monthCents = Math.max(0, cents(ctx.monthlyPrice));
  const subtotal = monthCents * ctx.months;
  if (rules.minAmount !== null && subtotal < cents(rules.minAmount)) return reject('min_amount');

  let discount = 0;
  let freeMonths = 0;
  if (rules.discountType === 'percentage') {
    discount = Math.round((subtotal * Math.min(rules.discountValue, 100)) / 100);
  } else if (rules.discountType === 'fixed') {
    discount = cents(rules.discountValue);
  } else {
    // Se paga al menos un mes.
    freeMonths = Math.min(Math.trunc(rules.discountValue), ctx.months - 1);
    discount = freeMonths * monthCents;
  }
  discount = Math.min(Math.max(0, discount), subtotal);
  return {
    valid: true,
    months: ctx.months,
    rentSubtotal: subtotal / 100,
    discountAmount: discount / 100,
    freeMonths,
    rentTotal: (subtotal - discount) / 100,
  };
}

/** Texto corto del descuento: «20 %», «30 €», «1 mes gratis desde 3 meses». */
export function couponSummary(c: {
  discountType: CouponDiscountType;
  discountValue: number;
  minMonths: number;
}): string {
  const from = c.minMonths > 1 ? ` desde ${c.minMonths} meses` : '';
  if (c.discountType === 'percentage') return `${c.discountValue} %${from}`;
  if (c.discountType === 'fixed') return `${eur(c.discountValue)}${from}`;
  const n = Math.trunc(c.discountValue);
  return `${n} ${n === 1 ? 'mes gratis' : 'meses gratis'}${from}`;
}

/** Monta el resumen del primer pago (importes en euros, sin IVA salvo los «WithVat»). */
export function buildFirstPaymentQuote(args: {
  monthlyPrice: number;
  months: number;
  vatRate: number;
  /** Descuento del cupón o del prepago, sin IVA. */
  discountAmount: number;
  freeMonths: number;
  deposit: number;
  insuranceWithVat?: number;
  /** Sin cupón ni prepago y pagando un mes: la 1ª factura se prorratea. */
  prorated: boolean;
  coupon: FirstPaymentQuoteDto['coupon'];
}): FirstPaymentQuoteDto {
  const monthCents = Math.round(args.monthlyPrice * 100);
  const subtotal = monthCents * args.months;
  const discount = Math.min(Math.max(0, Math.round(args.discountAmount * 100)), subtotal);
  const rentTotal = subtotal - discount;
  const withVat = Math.round((rentTotal * (100 + args.vatRate)) / 100);
  const deposit = Math.round(args.deposit * 100);
  const insurance = Math.round((args.insuranceWithVat ?? 0) * 100);
  return {
    months: args.months,
    monthlyPrice: monthCents / 100,
    vatRate: args.vatRate,
    rentSubtotal: subtotal / 100,
    discountAmount: discount / 100,
    freeMonths: args.freeMonths,
    rentTotal: rentTotal / 100,
    rentTotalWithVat: withVat / 100,
    insuranceWithVat: insurance / 100,
    deposit: deposit / 100,
    totalToPay: (withVat + insurance + deposit) / 100,
    prorated: args.prorated,
    coupon: args.coupon,
  };
}

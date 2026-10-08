import { z } from 'zod';

import { isValidSpanishTaxId, normalizeTaxId } from '../accounting/billing-details';
import { isValidIban, normalizeIban } from '../sepa';

/** Honorarios del administrador: % de lo cobrado o cuota fija mensual. */
export const OwnerFeeTypeEnum = z.enum(['percentage', 'fixed']);

export const CreateOwnerSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  taxId: z
    .string()
    .trim()
    .transform(normalizeTaxId)
    .refine(isValidSpanishTaxId, { message: 'NIF/CIF no válido' }),
  address: z.string().trim().max(300).optional().or(z.literal('')),
  city: z.string().trim().max(120).optional().or(z.literal('')),
  postalCode: z.string().trim().max(10).optional().or(z.literal('')),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  /** Cuenta donde se le transfiere la liquidación. '' = quitarla. */
  iban: z
    .string()
    .trim()
    .transform(normalizeIban)
    .refine((v) => v === '' || isValidIban(v), { message: 'IBAN no válido' })
    .optional(),
  feeType: OwnerFeeTypeEnum.default('percentage'),
  feeValue: z.number().min(0).max(100000).default(0),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});
export type CreateOwnerInput = z.infer<typeof CreateOwnerSchema>;

export const UpdateOwnerSchema = CreateOwnerSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateOwnerInput = z.infer<typeof UpdateOwnerSchema>;

export interface OwnerDto {
  id: string;
  legalName: string;
  taxId: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  email: string | null;
  phone: string | null;
  ibanLast4: string | null;
  feeType: 'percentage' | 'fixed';
  feeValue: number;
  notes: string | null;
  isActive: boolean;
  facilitiesCount: number;
  createdAt: string;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha YYYY-MM-DD');

/** Periodo de una liquidación al propietario (normalmente un mes). */
export const OwnerStatementPeriodSchema = z
  .object({ from: dateOnly, to: dateOnly })
  .refine((v) => v.from <= v.to, { message: 'El periodo está al revés' });
export type OwnerStatementPeriod = z.infer<typeof OwnerStatementPeriodSchema>;

export const SaveOwnerStatementSchema = z
  .object({
    from: dateOnly,
    to: dateOnly,
    /** Enviarla por email al propietario. */
    send: z.boolean().default(true),
  })
  .refine((v) => v.from <= v.to, { message: 'El periodo está al revés' });
export type SaveOwnerStatementInput = z.infer<typeof SaveOwnerStatementSchema>;

/** IVA de los honorarios del administrador (servicio sujeto al tipo general). */
export const OWNER_FEE_VAT_PCT = 21;

export interface OwnerStatementPaymentLine {
  date: string;
  invoiceNumber: string | null;
  customerName: string;
  unitCode: string | null;
  amount: number;
  /** Lo devuelto de ese cobro dentro del periodo (resta). */
  refunded: number;
}

export interface OwnerStatementExpenseLine {
  date: string;
  description: string;
  facilityName: string | null;
  amount: number;
}

export interface OwnerStatementDto {
  /** Null si es una vista previa sin guardar. */
  id: string | null;
  ownerId: string;
  ownerName: string;
  ownerTaxId: string;
  ownerIbanLast4: string | null;
  periodStart: string;
  periodEnd: string;
  /** Cobrado de sus contratos en el periodo. */
  collected: number;
  /** Devuelto en el periodo. */
  refunded: number;
  feeType: 'percentage' | 'fixed';
  feeValue: number;
  feeBase: number;
  feeVat: number;
  /** Gastos de sus locales en el periodo (pagados por cuenta suya). */
  expenses: number;
  /** IRPF retenido por los inquilinos en las facturas del periodo (informativo). */
  withholding: number;
  /** A transferir: cobrado − devuelto − honorarios con IVA − gastos. */
  net: number;
  /** Pendiente de cobro de sus contratos hoy (informativo). */
  pending: number;
  payments: OwnerStatementPaymentLine[];
  expenseLines: OwnerStatementExpenseLine[];
  sentAt: string | null;
  sentTo: string | null;
}

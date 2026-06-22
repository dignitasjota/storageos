import { z } from 'zod';

/** Normaliza un IBAN (sin espacios, mayúsculas). */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** Valida un IBAN por el dígito de control mod-97 (ISO 13616). */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1;
}

const ibanSchema = z
  .string()
  .trim()
  .transform(normalizeIban)
  .refine(isValidIban, { message: 'IBAN no válido (dígito de control incorrecto)' });

const bicSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'BIC no válido')
  .optional()
  .or(z.literal(''));

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

// ---------------------------------------------------------------------------
// Settings del acreedor
// ---------------------------------------------------------------------------

export const UpdateSepaSettingsSchema = z.object({
  creditorName: z.string().trim().min(2).max(140),
  /** Identificador del acreedor SEPA (p.ej. ES12ZZZB12345678). */
  creditorId: z.string().trim().min(8).max(35),
  /** Opcional al actualizar: si se omite, se conserva el IBAN ya guardado. */
  creditorIban: ibanSchema.optional(),
  creditorBic: bicSchema,
  enabled: z.boolean().default(false),
});
export type UpdateSepaSettingsInput = z.infer<typeof UpdateSepaSettingsSchema>;

export interface SepaSettingsDto {
  configured: boolean;
  creditorName: string;
  creditorId: string;
  creditorIbanLast4: string | null;
  creditorBic: string | null;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Mandatos
// ---------------------------------------------------------------------------

export const CreateSepaMandateSchema = z.object({
  customerId: z.string().uuid(),
  iban: ibanSchema,
  bic: bicSchema,
  /** Fecha de firma del mandato (YYYY-MM-DD). */
  signedAt: dateOnly,
});
export type CreateSepaMandateInput = z.infer<typeof CreateSepaMandateSchema>;

export interface SepaMandateDto {
  id: string;
  customerId: string;
  reference: string;
  ibanLast4: string;
  bic: string | null;
  signedAt: string;
  sequenceType: 'FRST' | 'RCUR';
  status: 'active' | 'cancelled';
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Remesas
// ---------------------------------------------------------------------------

export const CreateRemittanceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  /** Fecha de cobro (YYYY-MM-DD). */
  collectionDate: dateOnly,
  /** Facturas a incluir; si se omite, se incluyen todas las elegibles. */
  invoiceIds: z.array(z.string().uuid()).optional(),
});
export type CreateRemittanceInput = z.infer<typeof CreateRemittanceSchema>;

export interface RemittanceEligibleInvoiceDto {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  amount: number;
  mandateReference: string;
  ibanLast4: string;
  sequenceType: 'FRST' | 'RCUR';
}

export interface RemittancePreviewDto {
  eligible: RemittanceEligibleInvoiceDto[];
  total: number;
  /** Facturas domiciliables pero sin mandato activo (no se pueden incluir). */
  withoutMandate: { invoiceId: string; invoiceNumber: string; customerName: string }[];
}

export interface SepaRemittanceDto {
  id: string;
  name: string;
  messageId: string;
  collectionDate: string;
  status: 'generated' | 'confirmed' | 'cancelled';
  itemCount: number;
  total: number;
  createdAt: string;
  confirmedAt: string | null;
}

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
  /**
   * Días de preaviso de los adeudos. El reglamento SEPA exige 14 salvo que el
   * contrato con el deudor pacte otro plazo (mínimo habitual: 2).
   */
  prenoticeDays: z.number().int().min(1).max(30).default(14),
  enabled: z.boolean().default(false),
});
export type UpdateSepaSettingsInput = z.infer<typeof UpdateSepaSettingsSchema>;

export interface SepaSettingsDto {
  configured: boolean;
  creditorName: string;
  creditorId: string;
  creditorIbanLast4: string | null;
  creditorBic: string | null;
  prenoticeDays: number;
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
  /** Plazo de preaviso configurado (días): la fecha de cargo debería respetarlo. */
  prenoticeDays: number;
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
  /** Preavisos enviados a los deudores. */
  prenoticesSent: number;
  /** Adeudos sin preaviso (correo apagado, sin email o error). */
  prenoticesMissing: number;
  /** Adeudos cobrados, fallidos (rechazados o factura ya pagada) y devueltos. */
  collectedCount: number;
  failedCount: number;
  returnedCount: number;
}

/**
 * Estado de un adeudo: pending (remesa sin confirmar) · collected · failed
 * (rechazado por el banco o la factura ya estaba pagada) · returned (devuelto
 * tras cobrarse) · cancelled (remesa cancelada).
 */
export type SepaRemittanceItemStatus =
  | 'pending'
  | 'collected'
  | 'failed'
  | 'returned'
  | 'cancelled';

/** Confirmar el cobro de una remesa: los adeudos que el banco rechazó no se cobran. */
export const ConfirmRemittanceSchema = z.object({
  rejectedItemIds: z.array(z.string().uuid()).max(1000).optional(),
});
export type ConfirmRemittanceInput = z.infer<typeof ConfirmRemittanceSchema>;

/** Estado del preaviso de un adeudo: null = aún pendiente de enviar. */
export type SepaPrenoticeStatus = 'sent' | 'disabled' | 'no_email' | 'failed';

/** Constancia del preaviso de cada adeudo de una remesa. */
export interface SepaRemittancePrenoticeDto {
  itemId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  customerId: string;
  customerName: string;
  amount: number;
  status: SepaPrenoticeStatus | null;
  at: string | null;
  recipient: string | null;
  subject: string | null;
  text: string | null;
  /** Estado de entrega del correo, mientras siga en Comunicaciones. */
  deliveryStatus: string | null;
  /** Estado del adeudo y, si falló, por qué. */
  itemStatus: SepaRemittanceItemStatus;
  failureReason: string | null;
}

/**
 * Primera fecha de cargo (YYYY-MM-DD) que respeta el preaviso si se genera la
 * remesa hoy: el inquilino recibe el aviso hoy y el cargo llega `days` días
 * después.
 */
export function earliestCollectionDate(days: number, today: Date = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Días naturales que faltan hasta la fecha de cargo (negativo si ya pasó). */
export function daysUntilCollection(collectionDate: string, today: Date = new Date()): number {
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const c = Date.parse(`${collectionDate}T00:00:00Z`);
  return Math.round((c - t) / 86_400_000);
}

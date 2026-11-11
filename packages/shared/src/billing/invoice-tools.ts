import { z } from 'zod';

import { ManualPaymentMethodEnum } from './schemas';

import type { InvoiceStatusValue, PaymentRecordMethodValue, PaymentStatusValue } from './schemas';

// ============================================================================
// Lista de facturas: orden, filtros, totales y vistas guardadas
// ============================================================================

/** Orden de la lista. */
export const InvoiceSortEnum = z.enum(['newest', 'oldest', 'due', 'amount']);
export type InvoiceSortValue = z.infer<typeof InvoiceSortEnum>;

/** Tipo en la lista: completa, simplificada, rectificativa o justificante de fianza. */
export const InvoiceTypeFilterEnum = z.enum(['F1', 'F2', 'R', 'deposit']);
export type InvoiceTypeFilterValue = z.infer<typeof InvoiceTypeFilterEnum>;

/**
 * «Cobrada con» en la lista. `none`: emitida o vencida y sin forma de pago
 * guardada (ni tarjeta, ni domiciliación, ni mandato SEPA firmado).
 */
export const InvoicePaymentFilterEnum = z.enum([
  'card',
  'sepa_debit',
  'bank_transfer',
  'cash',
  'other',
  'none',
]);
export type InvoicePaymentFilterValue = z.infer<typeof InvoicePaymentFilterEnum>;

/** `GET /invoices/totals`: lo que suman las facturas de los filtros. */
export interface InvoiceTotalsDto {
  count: number;
  total: number;
  /** Lo que falta por cobrar de las emitidas y vencidas. */
  pending: number;
  /** Dinero cobrado (sin retenciones ni compensaciones), menos lo devuelto. */
  collected: number;
}

export const SaveInvoiceViewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  filters: z.record(z.unknown()),
});
export type SaveInvoiceViewInput = z.infer<typeof SaveInvoiceViewSchema>;

export interface InvoiceSavedViewDto {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  createdByName: string | null;
}

// ============================================================================
// Estado real del cobro
// ============================================================================

export interface InvoiceCollectionDto {
  /** Cobro con tarjeta o domiciliación en curso. */
  inFlight: boolean;
  /** En una remesa SEPA aún sin confirmar. */
  inRemittance: boolean;
  /** En un plan de pagos activo. */
  inPaymentPlan: boolean;
  /** Último recordatorio de pago enviado (ISO). */
  lastReminderAt: string | null;
}

// ============================================================================
// Ficha: cobros, devoluciones, avisos, escalado e historial
// ============================================================================

export type InvoiceRefundVia = 'gateway' | 'bank' | 'manual' | 'external' | 'credit';

export interface InvoicePaymentRowDto {
  id: string;
  amount: number;
  methodType: PaymentRecordMethodValue;
  gateway: string;
  status: PaymentStatusValue;
  /** ISO. */
  paidAt: string | null;
  refundedAmount: number;
  returnedAt: string | null;
  failureReason: string | null;
  notes: string | null;
  createdAt: string;
  /** Registrado a mano y sin devolver: se puede corregir o deshacer. */
  editable: boolean;
  /**
   * Por qué no se corrige ni se deshace desde aquí (viene de una remesa SEPA,
   * de la conciliación bancaria o es la fianza aplicada).
   */
  lockedReason: string | null;
  /** Deshecho por haberse registrado por error. */
  undone: boolean;
}

export interface InvoiceRefundRowDto {
  id: string;
  amount: number;
  via: InvoiceRefundVia;
  /** Forma del cobro devuelto (efectivo, transferencia…), si se sabe. */
  paymentMethod: PaymentRecordMethodValue | null;
  /** Cómo se devolvió el dinero (efectivo, transferencia, tarjeta…). */
  method: PaymentRecordMethodValue | null;
  reason: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface InvoiceCommunicationRowDto {
  id: string;
  channel: string;
  subject: string | null;
  recipient: string;
  status: string;
  source: string | null;
  createdAt: string;
  sentAt: string | null;
  errorMessage: string | null;
}

export interface InvoiceDunningRowDto {
  id: string;
  actionType: string;
  status: string;
  scheduledFor: string;
  executedAt: string | null;
  notes: string | null;
}

export interface InvoiceHistoryRowDto {
  id: string;
  action: string;
  userName: string | null;
  createdAt: string;
  changes: Record<string, unknown> | null;
}

/** `GET /invoices/:id/activity`. */
export interface InvoiceActivityDto {
  payments: InvoicePaymentRowDto[];
  refunds: InvoiceRefundRowDto[];
  communications: InvoiceCommunicationRowDto[];
  dunning: InvoiceDunningRowDto[];
  history: InvoiceHistoryRowDto[];
}

/** Deshacer un cobro registrado por error. */
export const UndoPaymentSchema = z.object({
  reason: z.string().trim().min(3, 'Escribe por qué').max(300),
});
export type UndoPaymentInput = z.infer<typeof UndoPaymentSchema>;

/** Corregir la fecha o la forma de un cobro registrado a mano. */
export const CorrectPaymentSchema = z
  .object({
    paidAt: z.string().datetime().optional(),
    methodType: ManualPaymentMethodEnum.optional(),
  })
  .refine((v) => v.paidAt !== undefined || v.methodType !== undefined, {
    message: 'Indica la fecha o la forma de pago',
  });
export type CorrectPaymentInput = z.infer<typeof CorrectPaymentSchema>;

// ============================================================================
// Enviar la factura por correo
// ============================================================================

export const SendInvoiceEmailSchema = z.object({
  /** Otro email (por defecto, el de facturación del inquilino o el suyo). */
  email: z.string().trim().email('Email no válido').max(320).optional(),
});
export type SendInvoiceEmailInput = z.infer<typeof SendInvoiceEmailSchema>;

export interface SendInvoiceEmailResultDto {
  recipient: string;
  communicationId: string;
}

// ============================================================================
// Anular: lo que va a pasar
// ============================================================================

/** `GET /invoices/:id/cancel-preview`. */
export interface InvoiceCancelPreviewDto {
  /** `cancel_draft`: se borra el borrador; `void`: rectificativa que la deja a cero. */
  action: 'cancel_draft' | 'void' | 'blocked';
  /** Por qué no se puede anular (tiene cobros, cobro en curso, en remesa…). */
  blockedReason: string | null;
  /** Importe de la rectificativa (negativo), si se emite una. */
  creditNoteTotal: number | null;
  /** Vuelve al contrato un mes gratis. */
  freeMonth: boolean;
  /** Saldo (€) que vuelve al contrato. */
  credit: number;
  /** Vuelve la recompensa de referido. */
  referralReward: boolean;
  /** Recargo por mora sin cobrar que se anula con ella. */
  lateFee: { id: string; invoiceNumber: string; total: number } | null;
  /** El inquilino tiene el acceso cortado por esta factura y lo recupera. */
  accessRestored: boolean;
  /** Es la cuota de un periodo: no se vuelve a generar sola. */
  periodic: boolean;
}

// ============================================================================
// Devoluciones
// ============================================================================

/** `GET /invoices/:id/refund-options`: cómo se devolvería el dinero. */
export interface InvoiceRefundOptionsDto {
  /** Lo que aún se puede devolver. */
  refundable: number;
  /** Cómo vuelve el dinero: la pasarela, el TPV del banco o a mano. */
  how: 'gateway' | 'bank' | 'manual' | 'none';
  /** Forma del cobro que se devuelve. */
  methodType: PaymentRecordMethodValue | null;
  /** Últimas cifras de la tarjeta o la cuenta, si se saben. */
  last4: string | null;
  /** Hay contrato: se puede dejar como saldo para su próxima factura. */
  creditAvailable: boolean;
}

// ============================================================================
// Cierre del mes
// ============================================================================

export const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes no válido');

export const MonthCloseGenerateSchema = z.object({ month: MonthSchema });
export type MonthCloseGenerateInput = z.infer<typeof MonthCloseGenerateSchema>;

export const MONTH_CLOSE_WARNINGS = [
  'no_email',
  'no_payment_method',
  'zero_total',
  'contract_ending',
  'no_tax_id',
  'previous_debt',
] as const;
export type MonthCloseWarning = (typeof MONTH_CLOSE_WARNINGS)[number];

export const MONTH_CLOSE_WARNING_LABELS: Record<MonthCloseWarning, string> = {
  no_email: 'Sin email: no le llegará la factura',
  no_payment_method: 'Sin forma de pago guardada: habrá que cobrarla a mano',
  zero_total: 'Sale a 0 €',
  contract_ending: 'Su contrato termina este mes',
  no_tax_id: 'Empresa sin NIF',
  previous_debt: 'Ya debe facturas anteriores',
};

export interface MonthCloseRowDto {
  invoiceId: string;
  /** null en los borradores. */
  invoiceNumber: string | null;
  status: InvoiceStatusValue;
  customerId: string | null;
  customerName: string | null;
  unitCode: string | null;
  facilityName: string | null;
  total: number;
  amountPending: number;
  /** Tiene tarjeta o domiciliación con la que cobrarla. */
  chargeable: boolean;
  warnings: MonthCloseWarning[];
}

/** `GET /invoices/month-close?month=`. */
export interface MonthCloseDto {
  month: string;
  /** Contratos vivos que deberían tener factura de ese mes y no la tienen. */
  missingContracts: number;
  drafts: MonthCloseRowDto[];
  /** Emitidas o vencidas del mes con algo pendiente. */
  pending: MonthCloseRowDto[];
  paidCount: number;
  /** Faltan datos fiscales del negocio para emitir. */
  issuerMissing: string[];
}

export interface MonthCloseGenerateResultDto {
  created: number;
}

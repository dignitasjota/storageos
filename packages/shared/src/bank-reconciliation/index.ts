import { z } from 'zod';

export const ImportN43Schema = z.object({
  filename: z.string().trim().min(1).max(200),
  /** Contenido del fichero Norma 43 (texto). */
  content: z.string().min(1),
});
export type ImportN43Input = z.infer<typeof ImportN43Schema>;

/**
 * Qué hacer con la parte de un abono que no cabe en las facturas elegidas:
 * `credit` = saldo a favor del contrato (lo descuenta su próxima factura);
 * `refund` = se le devuelve (queda anotado en el apunte).
 */
export const BankSurplusHandlingEnum = z.enum(['credit', 'refund']);
export type BankSurplusHandling = z.infer<typeof BankSurplusHandlingEnum>;

export const MatchTransactionSchema = z
  .object({
    invoiceId: z.string().uuid().optional(),
    /** Repartir un mismo ingreso entre varias facturas (en este orden). */
    invoiceIds: z.array(z.string().uuid()).min(1).max(20).optional(),
    /** Sin esto, un abono mayor que lo pendiente da 400 `transaction_surplus`. */
    surplus: BankSurplusHandlingEnum.optional(),
  })
  .refine((v) => Boolean(v.invoiceId) !== Boolean(v.invoiceIds?.length), {
    message: 'Indica una factura (invoiceId) o varias (invoiceIds)',
  });
export type MatchTransactionInput = z.infer<typeof MatchTransactionSchema>;

export const MarkReturnTransactionSchema = z.object({
  invoiceId: z.string().uuid(),
  /** El cobro que el banco devolvió (el de la sugerencia). */
  paymentId: z.string().uuid().optional(),
});
export type MarkReturnTransactionInput = z.infer<typeof MarkReturnTransactionSchema>;

export interface BankStatementDto {
  id: string;
  filename: string;
  accountLabel: string;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  /** Saldos del fichero, en euros. */
  initialBalance: number;
  finalBalance: number;
  transactionCount: number;
  matchedCount: number;
  /** Movimientos sin revisar (ni conciliados, ni devueltos, ni ignorados). */
  pendingCount: number;
  /** Lo que no cuadra en el fichero (saldos, totales, registros que faltan). */
  warnings: string[];
  createdAt: string;
}

export interface BankTransactionSuggestionDto {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  /** Abonos: lo pendiente de la factura. Devoluciones: el importe del cobro. */
  amountPending: number;
  /** Devoluciones: el cobro que se revertiría. */
  paymentId?: string;
  /** Devoluciones: cuándo se cobró y cómo. */
  paidAt?: string | null;
  methodType?: string;
  /** Algo a tener en cuenta antes de conciliar (p. ej. está en una remesa). */
  warning?: string;
}

export interface BankTransactionDto {
  id: string;
  operationDate: string | null;
  valueDate: string | null;
  /** importe en euros con signo: + abono, − cargo. */
  amount: number;
  type: 'credit' | 'debit';
  description: string;
  reference: string;
  status: 'pending' | 'matched' | 'ignored' | 'returned';
  matchedInvoiceId: string | null;
  matchedInvoiceNumber: string | null;
  /** Facturas que cobró este apunte (al repartirlo entre varias). */
  matchedInvoices: { id: string; invoiceNumber: string }[];
  /** Parte del abono que no se aplicó a ninguna factura, en euros. */
  unappliedAmount: number;
  /** Ese sobrante quedó como saldo a favor del contrato. */
  creditContractId: string | null;
  /** Sugerencias de factura (solo abonos pendientes) → marcar como cobrada. */
  suggestions: BankTransactionSuggestionDto[];
  /** Sugerencias de factura pagada (solo cargos pendientes) → devolución SEPA. */
  returnSuggestions: BankTransactionSuggestionDto[];
  /** Conciliado solo al importar. */
  autoMatched: boolean;
  /** Se puede deshacer (conciliación, devolución o «ignorado»). */
  canUndo: boolean;
}

export interface BankStatementDetailDto extends BankStatementDto {
  transactions: BankTransactionDto[];
}

export interface ImportN43ResultDto {
  statements: BankStatementDto[];
  /** Nº de movimientos de abono pendientes con al menos una sugerencia. */
  suggestedCount: number;
  /** Abonos conciliados solos al importar (con la conciliación automática activa). */
  autoMatchedCount: number;
  /** Movimientos que ya estaban en otro extracto importado (no se repiten). */
  duplicatesSkipped: number;
  /** Lo que no cuadra en el fichero. */
  warnings: string[];
}

export interface BankReconciliationSettingsDto {
  /**
   * Conciliar solos los abonos cuyo importe es exactamente lo pendiente de una
   * única factura y que llevan su número en el concepto o la referencia.
   */
  autoReconcile: boolean;
}

export const UpdateBankReconciliationSettingsSchema = z.object({
  autoReconcile: z.boolean(),
});
export type UpdateBankReconciliationSettingsInput = z.infer<
  typeof UpdateBankReconciliationSettingsSchema
>;

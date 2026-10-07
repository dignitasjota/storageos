import { z } from 'zod';

export const ImportN43Schema = z.object({
  filename: z.string().trim().min(1).max(200),
  /** Contenido del fichero Norma 43 (texto). */
  content: z.string().min(1),
});
export type ImportN43Input = z.infer<typeof ImportN43Schema>;

export const MatchTransactionSchema = z
  .object({
    invoiceId: z.string().uuid().optional(),
    /** Repartir un mismo ingreso entre varias facturas (en este orden). */
    invoiceIds: z.array(z.string().uuid()).min(1).max(20).optional(),
  })
  .refine((v) => Boolean(v.invoiceId) !== Boolean(v.invoiceIds?.length), {
    message: 'Indica una factura (invoiceId) o varias (invoiceIds)',
  });
export type MatchTransactionInput = z.infer<typeof MatchTransactionSchema>;

export const MarkReturnTransactionSchema = z.object({
  invoiceId: z.string().uuid(),
});
export type MarkReturnTransactionInput = z.infer<typeof MarkReturnTransactionSchema>;

export interface BankStatementDto {
  id: string;
  filename: string;
  accountLabel: string;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  transactionCount: number;
  matchedCount: number;
  createdAt: string;
}

export interface BankTransactionSuggestionDto {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  amountPending: number;
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
  /** Sugerencias de factura (solo abonos pendientes) → marcar como cobrada. */
  suggestions: BankTransactionSuggestionDto[];
  /** Sugerencias de factura pagada (solo cargos pendientes) → devolución SEPA. */
  returnSuggestions: BankTransactionSuggestionDto[];
  /** Conciliado solo al importar (se puede deshacer). */
  autoMatched: boolean;
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

import { z } from 'zod';

export const ImportN43Schema = z.object({
  filename: z.string().trim().min(1).max(200),
  /** Contenido del fichero Norma 43 (texto). */
  content: z.string().min(1),
});
export type ImportN43Input = z.infer<typeof ImportN43Schema>;

export const MatchTransactionSchema = z.object({
  invoiceId: z.string().uuid(),
});
export type MatchTransactionInput = z.infer<typeof MatchTransactionSchema>;

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
  status: 'pending' | 'matched' | 'ignored';
  matchedInvoiceId: string | null;
  matchedInvoiceNumber: string | null;
  /** Sugerencias de factura (solo abonos pendientes). */
  suggestions: BankTransactionSuggestionDto[];
}

export interface BankStatementDetailDto extends BankStatementDto {
  transactions: BankTransactionDto[];
}

export interface ImportN43ResultDto {
  statements: BankStatementDto[];
  /** Nº de movimientos de abono pendientes con al menos una sugerencia. */
  suggestedCount: number;
}

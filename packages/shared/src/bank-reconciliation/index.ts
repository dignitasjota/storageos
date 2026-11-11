import { z } from 'zod';

import { ExpenseCategoryEnum } from '../expenses';

export * from './matching';

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
    /** Recordar: si el concepto lleva esto, es de este inquilino (regla). */
    rememberPattern: z.string().trim().min(3).max(100).optional(),
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

/** El abono de una remesa SEPA, de una vez. */
export const MatchRemittanceSchema = z.object({ remittanceId: z.string().uuid() });
export type MatchRemittanceInput = z.infer<typeof MatchRemittanceSchema>;

/** Un cargo que es un gasto del negocio (luz, alquiler, seguros…). */
export const ClassifyExpenseSchema = z.object({
  category: ExpenseCategoryEnum,
  description: z.string().trim().min(1).max(300).optional(),
  facilityId: z.string().uuid().optional(),
  /** Recordar: si el concepto lleva esto, es un gasto de esta categoría. */
  rememberPattern: z.string().trim().min(3).max(100).optional(),
});
export type ClassifyExpenseInput = z.infer<typeof ClassifyExpenseSchema>;

/** Reglas aprendidas: «si el concepto lleva X, es de este inquilino / este gasto». */
export const BankMatchRuleKindEnum = z.enum(['customer', 'expense']);
export type BankMatchRuleKind = z.infer<typeof BankMatchRuleKindEnum>;

export const CreateBankMatchRuleSchema = z
  .object({
    pattern: z.string().trim().min(3).max(100),
    kind: BankMatchRuleKindEnum,
    customerId: z.string().uuid().optional(),
    expenseCategory: ExpenseCategoryEnum.optional(),
  })
  .refine((r) => (r.kind === 'customer' ? !!r.customerId : !!r.expenseCategory), {
    message: 'Indica el inquilino o la categoría del gasto',
  });
export type CreateBankMatchRuleInput = z.infer<typeof CreateBankMatchRuleSchema>;

export interface BankMatchRuleDto {
  id: string;
  pattern: string;
  kind: BankMatchRuleKind;
  customerId: string | null;
  customerName: string | null;
  expenseCategory: string | null;
  /** Veces que se ha usado al conciliar. */
  hits: number;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * El CSV de movimientos que da la banca online: qué columna es cada cosa (por
 * su posición, desde 0). El importe va en una columna con signo o en dos
 * (cargos y abonos).
 */
export const BankCsvMappingSchema = z
  .object({
    date: z.number().int().min(0).max(100),
    description: z.number().int().min(0).max(100),
    amount: z.number().int().min(0).max(100).optional(),
    debit: z.number().int().min(0).max(100).optional(),
    credit: z.number().int().min(0).max(100).optional(),
    valueDate: z.number().int().min(0).max(100).optional(),
    balance: z.number().int().min(0).max(100).optional(),
  })
  .refine((m) => m.amount !== undefined || m.debit !== undefined || m.credit !== undefined, {
    message: 'Indica la columna del importe (o las de cargos y abonos)',
  });
export type BankCsvMapping = z.infer<typeof BankCsvMappingSchema>;

export const ImportBankCsvSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(5_000_000),
  /** Sin esto se reconocen las columnas por su título. */
  mapping: BankCsvMappingSchema.optional(),
});
export type ImportBankCsvInput = z.infer<typeof ImportBankCsvSchema>;

export interface BankStatementDto {
  id: string;
  /** De dónde salió: fichero Norma 43 o CSV de la banca online. */
  source: 'n43' | 'csv';
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
  /** Varias facturas del mismo inquilino que suman el ingreso (en este orden). */
  invoiceIds?: string[];
  invoiceNumbers?: string[];
  /**
   * Por qué se sugiere: el importe exacto, el número de factura en el concepto,
   * el nombre del ordenante, una regla aprendida o la suma de sus facturas.
   */
  reason?: 'amount' | 'reference' | 'payer' | 'rule' | 'sum';
}

/** Una remesa SEPA cuyo abono es este ingreso. */
export interface BankRemittanceSuggestionDto {
  remittanceId: string;
  name: string;
  amount: number;
  collectionDate: string;
  status: 'generated' | 'confirmed';
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
  status: 'pending' | 'matched' | 'ignored' | 'returned' | 'expense';
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
  /** Remesas SEPA cuyo abono es este ingreso (de una vez). */
  remittanceSuggestions: BankRemittanceSuggestionDto[];
  /** La remesa con la que se concilió. */
  matchedRemittance: { id: string; name: string } | null;
  /** El gasto en que se convirtió un cargo. */
  expense: { id: string; category: string } | null;
  /** Una regla dice que este cargo es un gasto de esta categoría. */
  expenseSuggestion: { category: string; pattern: string } | null;
  /** Lo que identifica al ordenante en el concepto (para recordarlo). */
  payerPattern: string;
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

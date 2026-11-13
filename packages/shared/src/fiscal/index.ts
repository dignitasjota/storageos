import { z } from 'zod';

import type { InvoiceTaxCategory } from '../billing/tax-category';

/**
 * Informes fiscales (España): libro registro de IVA emitido, resumen del
 * modelo 303 (IVA devengado/repercutido) y modelo 347 (operaciones con
 * terceros > 3.005,06 €/año). Todo derivado de las facturas emitidas; no
 * incluye IVA soportado (compras), que el sistema no gestiona.
 */

/** Umbral del modelo 347 (operaciones con un tercero, IVA incluido, anual). */
export const MODEL_347_THRESHOLD = 3005.06;

// --- Libro registro de facturas expedidas (IVA emitido) ---

export interface VatBookRow {
  invoiceNumber: string;
  issueDate: string | null;
  invoiceType: string;
  customerName: string;
  customerNif: string | null;
  base: number;
  vat: number;
  total: number;
}

export interface VatBookByRate {
  rate: number;
  /** S1 con IVA · E1–E6 exenta · N1/N2 no sujeta. */
  taxCategory: InvoiceTaxCategory;
  base: number;
  vat: number;
}

export interface VatBookDto {
  from: string;
  to: string;
  rows: VatBookRow[];
  byRate: VatBookByRate[];
  totals: { base: number; vat: number; total: number };
}

// --- Modelo 303 (IVA devengado por tipo, trimestral) ---

export interface Model303Dto {
  year: number;
  quarter: number;
  /** Desglose del IVA devengado por tipo impositivo. */
  byRate: VatBookByRate[];
  totalBase: number;
  totalVat: number;
  invoiceCount: number;
  /** IVA soportado deducible: gastos desglosados del trimestre con el IVA deducible. */
  received: {
    byRate: { rate: number; base: number; vat: number }[];
    base: number;
    vat: number;
    count: number;
  };
  /** Gastos del trimestre sin desglosar (no restan IVA hasta que se desglosen). */
  unbroken: { count: number; amount: number };
  /** IVA devengado − IVA deducible (positivo: a ingresar; negativo: a compensar o devolver). */
  result: number;
}

// --- Modelo 347 (operaciones con terceros > 3.005,06 €/año) ---

/** Cobros en efectivo de un mismo cliente en el año a partir de los que se informan en el 347. */
export const MODEL_347_CASH_THRESHOLD = 6000;

export interface Model347Row {
  customerName: string;
  nif: string;
  total: number;
  q1: number;
  q2: number;
  q3: number;
  q4: number;
  /** Cobrado en efectivo en el año (se informa si pasa de 6.000 €). */
  cash: number;
}

export interface Model347SupplierRow {
  supplierName: string;
  nif: string;
  total: number;
  q1: number;
  q2: number;
  q3: number;
  q4: number;
}

export interface Model347Dto {
  year: number;
  threshold: number;
  /** Clientes (ventas). */
  rows: Model347Row[];
  /** Proveedores (compras): gastos desglosados, IVA incluido y sin los que llevan retención. */
  suppliers: Model347SupplierRow[];
  /** Terceros que superan el umbral sin NIF: no se pueden declarar así. */
  withoutNif: { name: string; total: number; kind: 'customer' | 'supplier' }[];
}

// --- Exportación contable (A3/Sage y similares) ---

/**
 * Una fila por (factura × tipo de IVA presente en ella): una factura con
 * líneas a distinto tipo (p. ej. alquiler 21% + fianza 0%) genera varias
 * filas, para que el asiento contable separe correctamente cada cuota.
 * Ni A3 ni Sage exigen un layout fijo — sus importadores dejan mapear las
 * columnas la primera vez (plantilla reutilizable después).
 */
export interface AccountingExportRow {
  invoiceNumber: string;
  issueDate: string | null;
  invoiceType: string;
  customerName: string;
  customerNif: string | null;
  taxRate: number;
  /** S1 con IVA · E1–E6 exenta · N1/N2 no sujeta. */
  taxCategory: InvoiceTaxCategory;
  base: number;
  vat: number;
  lineTotal: number;
  invoiceTotal: number;
  status: string;
}

export interface AccountingExportDto {
  from: string;
  to: string;
  rows: AccountingExportRow[];
}

// --- Libro de facturas recibidas (gastos con factura) ---

export interface ReceivedInvoiceRow {
  expenseId: string;
  /** Fecha de la factura (YYYY-MM-DD). */
  date: string;
  vendor: string | null;
  vendorTaxId: string | null;
  invoiceNumber: string | null;
  description: string;
  categoryLabel: string;
  facilityName: string | null;
  base: number;
  vatRate: number;
  vat: number;
  /** false = el IVA no se deduce. */
  deductible: boolean;
  withholding: number;
  withholdingModel: '111' | '115' | null;
  total: number;
  hasReceipt: boolean;
}

export interface ReceivedInvoicesBookDto {
  from: string;
  to: string;
  rows: ReceivedInvoiceRow[];
  /** Por tipo de IVA (solo lo deducible). */
  byRate: { rate: number; base: number; vat: number }[];
  totals: { base: number; vat: number; deductibleVat: number; withholding: number; total: number };
  /** Gastos del periodo sin desglosar (no están en el libro). */
  unbroken: { count: number; amount: number };
}

// --- Retenciones practicadas (111 y 115) ---

export interface WithholdingPayeeDto {
  name: string;
  nif: string | null;
  base: number;
  amount: number;
}

export interface WithholdingModelDto {
  model: '111' | '115';
  count: number;
  base: number;
  amount: number;
  payees: WithholdingPayeeDto[];
}

export interface WithholdingsDto {
  year: number;
  quarter: number;
  /** Las que practicas tú en los gastos (las ingresas con el 111 o el 115). */
  models: WithholdingModelDto[];
  /** Las que te practican tus inquilinos empresa en sus facturas (a cuenta de tu impuesto). */
  received: { count: number; base: number; amount: number };
}

// --- Antes de presentar y cierre del trimestre ---

export type FiscalCheckSeverity = 'error' | 'warning' | 'info';

export interface FiscalCheckDto {
  key: string;
  severity: FiscalCheckSeverity;
  title: string;
  detail: string;
  count: number;
  items: { label: string; href: string | null }[];
}

export interface FiscalClosureSnapshot {
  vatAccrued: number;
  vatDeductible: number;
  result: number;
  withholding111: number;
  withholding115: number;
  invoiceCount: number;
  expenseCount: number;
}

export interface FiscalClosureDto {
  id: string;
  year: number;
  quarter: number;
  closedAt: string;
  closedByName: string | null;
  snapshot: FiscalClosureSnapshot;
  reopenedAt: string | null;
  reopenReason: string | null;
}

export interface FiscalChecksDto {
  year: number;
  quarter: number;
  /** El trimestre ya terminó (solo entonces se puede cerrar). */
  ended: boolean;
  checks: FiscalCheckDto[];
  /** El cierre vigente del trimestre, si lo hay. */
  closure: FiscalClosureDto | null;
}

export const CloseFiscalQuarterSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  quarter: z.number().int().min(1).max(4),
});
export type CloseFiscalQuarterInput = z.infer<typeof CloseFiscalQuarterSchema>;

export const ReopenFiscalQuarterSchema = z.object({
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});
export type ReopenFiscalQuarterInput = z.infer<typeof ReopenFiscalQuarterSchema>;

// --- Envío a la asesoría ---

export const AccountantReportFrequencyEnum = z.enum(['off', 'monthly', 'quarterly']);
export type AccountantReportFrequency = z.infer<typeof AccountantReportFrequencyEnum>;
export const ACCOUNTANT_REPORT_FREQUENCY_LABELS: Record<AccountantReportFrequency, string> = {
  off: 'No enviar',
  monthly: 'Cada mes',
  quarterly: 'Cada trimestre',
};

export const UpdateAccountantSettingsSchema = z.object({
  email: z.string().trim().email().max(200).or(z.literal('')),
  frequency: AccountantReportFrequencyEnum,
});
export type UpdateAccountantSettingsInput = z.infer<typeof UpdateAccountantSettingsSchema>;

export interface AccountantSettingsDto {
  email: string | null;
  frequency: AccountantReportFrequency;
  /** Último periodo enviado («2026-10» o «2026-T3»). */
  lastPeriod: string | null;
}

export const SendAccountantReportSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export interface AccountantSendResultDto {
  sentTo: string;
  from: string;
  to: string;
}

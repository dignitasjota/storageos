import { z } from 'zod';

import { INVOICE_TAX_CATEGORY_LABELS, type InvoiceTaxCategory } from '../billing/tax-category';

/**
 * Exportación para la asesoría: facturas emitidas y cobros de la SL en un
 * periodo, juntando sus dos actividades —las suscripciones que cobra a los
 * tenants y su propio negocio de trasteros— en un formato estándar que el
 * asesor configura una vez en el importador de su programa contable.
 */

export const AccountantExportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
  /** Solo para CSV (un fichero por tabla). */
  kind: z.enum(['invoices', 'payments', 'deposits']).default('invoices'),
});
export type AccountantExportQuery = z.infer<typeof AccountantExportQuerySchema>;

export type AccountantSource = 'subscriptions' | 'own_business';

export const ACCOUNTANT_SOURCE_LABELS: Record<AccountantSource, string> = {
  subscriptions: 'Suscripciones',
  own_business: 'Negocio propio',
};

/** Una fila por factura y tipo de IVA presente en ella. */
export interface AccountantInvoiceRow {
  source: AccountantSource;
  invoiceNumber: string;
  /** DD/MM/AAAA. */
  issueDate: string;
  /** F1, F2, R1… */
  invoiceType: string;
  /** Número de la factura que rectifica (solo rectificativas). */
  rectifies: string | null;
  customerNif: string | null;
  customerName: string;
  customerAddress: string | null;
  taxRate: number;
  /** S1 con IVA · E1–E6 exenta · N1/N2 no sujeta. */
  taxCategory: InvoiceTaxCategory;
  base: number;
  vat: number;
  lineTotal: number;
  invoiceTotal: number;
  /** Retención de IRPF de la factura (solo en su primera fila, para no sumarla dos veces). */
  withholding: number;
  status: string;
}

/** Un cobro (o devolución, con importe negativo) aplicado a una factura. */
export interface AccountantPaymentRow {
  source: AccountantSource;
  /** DD/MM/AAAA. */
  date: string;
  invoiceNumber: string | null;
  customerNif: string | null;
  customerName: string;
  amount: number;
  /** Tarjeta, Domiciliación SEPA, Transferencia… */
  method: string;
  reference: string | null;
}

/**
 * Movimiento de fianza (no es un ingreso ni lleva IVA): recibida al cobrarla,
 * devuelta al liquidar el contrato (en negativo) o retenida (pasa a ser del
 * negocio, p. ej. para cubrir una deuda o daños).
 */
export interface AccountantDepositRow {
  source: AccountantSource;
  /** DD/MM/AAAA. */
  date: string;
  movement: 'received' | 'returned' | 'retained';
  /** Justificante de la fianza (FZ-…) o número de contrato. */
  document: string;
  contractNumber: string | null;
  customerNif: string | null;
  customerName: string;
  amount: number;
  /** Forma de cobro (recibida) o motivo (retenida). */
  detail: string | null;
}

export const DEPOSIT_MOVEMENT_LABELS: Record<AccountantDepositRow['movement'], string> = {
  received: 'Fianza recibida',
  returned: 'Fianza devuelta',
  retained: 'Fianza retenida',
};

export interface AccountantExportWarning {
  invoiceNumber: string;
  source: AccountantSource;
  missing: string[];
}

export interface AccountantExportDto {
  from: string;
  to: string;
  /** Nombre del negocio propio incluido, o null si no hay ninguno configurado. */
  ownBusinessName: string | null;
  invoices: AccountantInvoiceRow[];
  payments: AccountantPaymentRow[];
  /** Fianzas recibidas, devueltas y retenidas (aparte de los cobros: no son ingresos). */
  deposits: AccountantDepositRow[];
  /** Facturas a las que les faltan datos obligatorios del destinatario. */
  warnings: AccountantExportWarning[];
}

type Column<T> = { header: string; value: (row: T) => string | number | null };

export const ACCOUNTANT_INVOICE_COLUMNS: Column<AccountantInvoiceRow>[] = [
  { header: 'Actividad', value: (r) => ACCOUNTANT_SOURCE_LABELS[r.source] },
  { header: 'Nº factura', value: (r) => r.invoiceNumber },
  { header: 'Fecha', value: (r) => r.issueDate },
  { header: 'Tipo', value: (r) => r.invoiceType },
  { header: 'Rectifica a', value: (r) => r.rectifies },
  { header: 'NIF', value: (r) => r.customerNif },
  { header: 'Cliente', value: (r) => r.customerName },
  { header: 'Domicilio', value: (r) => r.customerAddress },
  { header: '% IVA', value: (r) => r.taxRate },
  { header: 'Operación', value: (r) => INVOICE_TAX_CATEGORY_LABELS[r.taxCategory] },
  { header: 'Base imponible', value: (r) => r.base },
  { header: 'Cuota IVA', value: (r) => r.vat },
  { header: 'Total línea', value: (r) => r.lineTotal },
  { header: 'Total factura', value: (r) => r.invoiceTotal },
  { header: 'Retención IRPF', value: (r) => r.withholding },
  { header: 'Estado', value: (r) => r.status },
];

export const ACCOUNTANT_PAYMENT_COLUMNS: Column<AccountantPaymentRow>[] = [
  { header: 'Actividad', value: (r) => ACCOUNTANT_SOURCE_LABELS[r.source] },
  { header: 'Fecha', value: (r) => r.date },
  { header: 'Nº factura', value: (r) => r.invoiceNumber },
  { header: 'NIF', value: (r) => r.customerNif },
  { header: 'Cliente', value: (r) => r.customerName },
  { header: 'Importe', value: (r) => r.amount },
  { header: 'Forma de cobro', value: (r) => r.method },
  { header: 'Referencia', value: (r) => r.reference },
];

export const ACCOUNTANT_DEPOSIT_COLUMNS: Column<AccountantDepositRow>[] = [
  { header: 'Actividad', value: (r) => ACCOUNTANT_SOURCE_LABELS[r.source] },
  { header: 'Fecha', value: (r) => r.date },
  { header: 'Movimiento', value: (r) => DEPOSIT_MOVEMENT_LABELS[r.movement] },
  { header: 'Documento', value: (r) => r.document },
  { header: 'Contrato', value: (r) => r.contractNumber },
  { header: 'NIF', value: (r) => r.customerNif },
  { header: 'Cliente', value: (r) => r.customerName },
  { header: 'Importe', value: (r) => r.amount },
  { header: 'Detalle', value: (r) => r.detail },
];

/** En la exportación de un tenant sobra la columna «Actividad» (solo hay una). */
export function withoutActivity<T>(columns: Column<T>[]): Column<T>[] {
  return columns.filter((c) => c.header !== 'Actividad');
}

const csvCell = (v: string | number | null): string => {
  if (v === null) return '';
  // Importes con coma decimal (Excel y programas contables en es-ES).
  const s = typeof v === 'number' ? v.toFixed(2).replace('.', ',') : v;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV con `;`, coma decimal y BOM UTF-8 (lo abre bien Excel en español). */
export function toAccountantCsv<T>(columns: Column<T>[], rows: T[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(';')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(';'));
  return String.fromCharCode(0xfeff) + lines.join('\r\n');
}

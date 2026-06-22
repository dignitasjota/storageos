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
  byRate: { rate: number; base: number; vat: number }[];
  totalBase: number;
  totalVat: number;
  invoiceCount: number;
}

// --- Modelo 347 (operaciones con terceros > 3.005,06 €/año) ---

export interface Model347Row {
  customerName: string;
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
  rows: Model347Row[];
}

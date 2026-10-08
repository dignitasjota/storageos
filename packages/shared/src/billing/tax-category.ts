import { z } from 'zod';

/**
 * Tipo fiscal de una línea de factura, con los códigos de Veri*Factu:
 * - `S1`: sujeta y no exenta (lleva IVA).
 * - `E1`–`E6`: exenta, según el artículo de la Ley 37/1992 del IVA que la exime
 *   (E1 = art. 20, p. ej. el alquiler de vivienda, art. 20.Uno.23.º).
 * - `N1`/`N2`: no sujeta (fianzas, indemnizaciones como el recargo por mora).
 * Exentas y no sujetas van siempre al 0 % y se declaran distinto.
 */
export const InvoiceTaxCategoryEnum = z.enum([
  'S1',
  'E1',
  'E2',
  'E3',
  'E4',
  'E5',
  'E6',
  'N1',
  'N2',
]);
export type InvoiceTaxCategory = z.infer<typeof InvoiceTaxCategoryEnum>;

export const INVOICE_TAX_CATEGORY_LABELS: Record<InvoiceTaxCategory, string> = {
  S1: 'Con IVA',
  E1: 'Exenta (art. 20 LIVA)',
  E2: 'Exenta (art. 21 LIVA, exportación)',
  E3: 'Exenta (art. 22 LIVA)',
  E4: 'Exenta (arts. 23 y 24 LIVA)',
  E5: 'Exenta (art. 25 LIVA, entrega intracomunitaria)',
  E6: 'Exenta (otros)',
  N1: 'No sujeta',
  N2: 'No sujeta por reglas de localización',
};

/** Mención que debe figurar en la factura (art. 6.1.j del Reglamento de facturación). */
export const INVOICE_TAX_CATEGORY_LEGAL_TEXT: Partial<Record<InvoiceTaxCategory, string>> = {
  E1: 'Operación exenta de IVA según el artículo 20 de la Ley 37/1992.',
  E2: 'Operación exenta de IVA según el artículo 21 de la Ley 37/1992.',
  E3: 'Operación exenta de IVA según el artículo 22 de la Ley 37/1992.',
  E4: 'Operación exenta de IVA según los artículos 23 y 24 de la Ley 37/1992.',
  E5: 'Operación exenta de IVA según el artículo 25 de la Ley 37/1992.',
  E6: 'Operación exenta de IVA.',
  N1: 'Operación no sujeta a IVA.',
  N2: 'Operación no sujeta a IVA por las reglas de localización.',
};

/** Tipo por defecto: con IVA si lleva tipo; al 0 %, no sujeta (como hasta ahora). */
export function defaultTaxCategory(taxRate: number): InvoiceTaxCategory {
  return taxRate > 0 ? 'S1' : 'N1';
}

export function isExemptCategory(c: InvoiceTaxCategory): boolean {
  return c.startsWith('E');
}

/** Exentas y no sujetas no pueden llevar IVA. */
export function taxCategoryAllowsRate(c: InvoiceTaxCategory, taxRate: number): boolean {
  return c === 'S1' || taxRate === 0;
}

/** Tipo de inmueble de un tipo de unidad: trastero (por defecto) o vivienda. */
export const PropertyKindEnum = z.enum(['storage', 'housing']);
export type PropertyKind = z.infer<typeof PropertyKindEnum>;

export const PROPERTY_KIND_LABELS: Record<PropertyKind, string> = {
  storage: 'Trastero',
  housing: 'Vivienda',
};

/**
 * IVA del alquiler según el inmueble: un trastero lleva el 21 %; el
 * arrendamiento de vivienda está exento (art. 20.1.23.º de la Ley del IVA).
 */
export function rentTax(kind: string | null | undefined): {
  taxRate: number;
  taxCategory: InvoiceTaxCategory;
} {
  return kind === 'housing'
    ? { taxRate: 0, taxCategory: 'E1' }
    : { taxRate: 21, taxCategory: 'S1' };
}

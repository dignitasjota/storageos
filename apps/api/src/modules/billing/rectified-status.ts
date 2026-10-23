/**
 * Una factura en estado `rectified` puede estar anulada (su rectificativa de
 * abono la deja a cero) o sustituida (una rectificativa por sustitución lleva
 * los importes nuevos). En los informes para la asesoría hay que decir cuál.
 */
export interface RectifiedByRef {
  invoiceNumber: string;
  correctionMethod: string | null;
}

export function rectifiedStatusLabel(rectifiedBy: RectifiedByRef[]): string {
  const substitution = rectifiedBy.find((r) => r.correctionMethod === 'by_substitution');
  if (substitution) return `Sustituida por ${substitution.invoiceNumber}`;
  const credit = rectifiedBy[0];
  return credit ? `Anulada (abono ${credit.invoiceNumber})` : 'Anulada (con rectificativa)';
}

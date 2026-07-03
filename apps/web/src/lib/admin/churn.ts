/**
 * Etiquetas de los motivos de baja (churn) de un tenant, para el super admin.
 * Incluye los motivos CAPTURABLES al suspender y los INFERIDOS por el reporte
 * (`voluntary`, `unknown`).
 */
export const CHURN_REASON_LABELS: Record<string, string> = {
  price: 'Precio',
  missing_features: 'Faltan funciones',
  business_closure: 'Cierre del negocio',
  competitor: 'Competencia',
  nonpayment: 'Impago',
  other: 'Otro',
  voluntary: 'Voluntaria (inferida)',
  unknown: 'Sin determinar',
};

/** Motivos seleccionables al suspender/cancelar un tenant (los capturables). */
export const CHURN_REASONS: { value: string; label: string }[] = [
  'price',
  'missing_features',
  'business_closure',
  'competitor',
  'nonpayment',
  'other',
].map((value) => ({ value, label: CHURN_REASON_LABELS[value] ?? value }));

export function churnReasonLabel(reason: string): string {
  return CHURN_REASON_LABELS[reason] ?? reason;
}

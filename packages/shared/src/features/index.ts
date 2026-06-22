/**
 * Features de tenant gateadas por **plan de suscripción**. Permite vender planes
 * (Básico/Pro) que muestran u ocultan módulos completos. Las features "base"
 * (operativa diaria) NO se gatean; aquí solo viven las **premium**.
 *
 * El mapa plan→features vive en código (`PLAN_FEATURES`), indexado por el slug
 * del plan. Un plan desconocido (o custom) recibe **todas** las features
 * (default seguro: nunca se oculta algo por error de configuración).
 */
export const TenantFeatures = [
  'ai_assistant', // /assistant
  'sepa', // /sepa-remittances
  'bank_reconciliation', // /bank-reconciliation
  'rent_increases', // /rent-increases (ECRI)
  'insurance', // /insurance-plans
  'access_control', // /access
  'automations', // /automations
] as const;

export type TenantFeature = (typeof TenantFeatures)[number];

/** Features incluidas en cada plan (por slug). */
export const PLAN_FEATURES: Record<string, TenantFeature[]> = {
  free: [],
  starter: ['rent_increases', 'insurance', 'access_control', 'automations'],
  pro: [...TenantFeatures],
};

/** Features efectivas de un plan. Slug desconocido → todas (default seguro). */
export function featuresForPlan(slug: string): TenantFeature[] {
  return PLAN_FEATURES[slug] ?? [...TenantFeatures];
}

/** Etiquetas legibles (UI de upsell + super-admin). */
export const FEATURE_LABELS: Record<TenantFeature, string> = {
  ai_assistant: 'Asistente IA',
  sepa: 'Remesas SEPA',
  bank_reconciliation: 'Conciliación bancaria',
  rent_increases: 'Subidas de precio (ECRI)',
  insurance: 'Seguros',
  access_control: 'Control de accesos',
  automations: 'Automatizaciones',
};

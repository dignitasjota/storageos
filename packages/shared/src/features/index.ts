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
  'custom_domain', // dominio propio en la landing/portal (white-label)
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

/** Filtra un valor arbitrario (jsonb/array de BD) a `TenantFeature[]` válidos. */
export function normalizePlanFeatures(value: unknown): TenantFeature[] {
  if (!Array.isArray(value)) return [];
  const valid = new Set<string>(TenantFeatures);
  return value.filter((v): v is TenantFeature => typeof v === 'string' && valid.has(v));
}

/**
 * Features de un plan leídas de la BD (`tenantFeatures`), con **fallback** al
 * mapa en código (`featuresForPlan(slug)`) si la lista está vacía/ausente — así
 * un plan aún sin poblar sigue funcionando y nunca se rompe el gating.
 */
export function resolvePlanFeatures(plan: {
  slug: string;
  tenantFeatures?: unknown;
}): TenantFeature[] {
  const fromDb = normalizePlanFeatures(plan.tenantFeatures);
  return fromDb.length > 0 ? fromDb : featuresForPlan(plan.slug);
}

/** Un override de feature por tenant (lo fija el super admin). */
export interface FeatureOverride {
  feature: TenantFeature;
  enabled: boolean;
}

/** Features efectivas a partir de una lista base + overrides (data-driven). */
export function effectiveFeaturesFromList(
  base: TenantFeature[],
  overrides: FeatureOverride[],
): TenantFeature[] {
  const set = new Set(base);
  for (const o of overrides) {
    if (o.enabled) set.add(o.feature);
    else set.delete(o.feature);
  }
  return [...set];
}

/**
 * Features efectivas de un tenant: las del plan, más las activadas por override
 * (`enabled=true`) y menos las desactivadas (`enabled=false`).
 *
 * @deprecated resuelve por slug (mapa en código). Prefiere
 * `effectiveFeaturesFromList(resolvePlanFeatures(plan), overrides)` para leer las
 * features del plan desde la BD.
 */
export function effectiveFeatures(slug: string, overrides: FeatureOverride[]): TenantFeature[] {
  return effectiveFeaturesFromList(featuresForPlan(slug), overrides);
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
  custom_domain: 'Dominio propio (white-label)',
};

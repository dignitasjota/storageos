import { z } from 'zod';

import type { TenantFeature } from '../features';

/**
 * Salud, Adopción y Uso del super admin: pesos configurables, riesgo de baja,
 * probabilidad de pago de una prueba, acción sugerida, previsión simple y los
 * DTO de las vistas nuevas (historial, candidatos, matriz, evolución).
 */

// --- Pesos de los factores ----------------------------------------------------

export const HEALTH_CLIENT_FACTOR_KEYS = [
  'engagement',
  'billing',
  'subscription',
  'adoption',
  'portal',
  'support',
] as const;
export type HealthClientFactorKey = (typeof HEALTH_CLIENT_FACTOR_KEYS)[number];

export const HEALTH_TRIAL_FACTOR_KEYS = [
  'facility',
  'units',
  'customer',
  'contract',
  'invoice',
  'team',
] as const;
export type HealthTrialFactorKey = (typeof HEALTH_TRIAL_FACTOR_KEYS)[number];

export type HealthClientWeights = Record<HealthClientFactorKey, number>;
export type HealthTrialWeights = Record<HealthTrialFactorKey, number>;

/** Pesos por defecto (en %, suman 100). */
export const DEFAULT_HEALTH_CLIENT_WEIGHTS: HealthClientWeights = {
  engagement: 30,
  billing: 20,
  subscription: 20,
  adoption: 15,
  portal: 10,
  support: 5,
};
export const DEFAULT_HEALTH_TRIAL_WEIGHTS: HealthTrialWeights = {
  facility: 15,
  units: 15,
  customer: 15,
  contract: 25,
  invoice: 15,
  team: 15,
};

export const HEALTH_FACTOR_LABELS: Record<HealthClientFactorKey | HealthTrialFactorKey, string> = {
  engagement: 'Actividad del equipo',
  billing: 'Facturación al día',
  subscription: 'Suscripción',
  adoption: 'Adopción',
  portal: 'Área de clientes',
  support: 'Soporte',
  facility: 'Local creado',
  units: 'Trasteros dados de alta',
  customer: 'Primer inquilino',
  contract: 'Primer contrato firmado',
  invoice: 'Primera factura emitida',
  team: 'Equipo entrando',
};

const weight = z.number().int().min(0).max(100);
const sums100 = (v: Record<string, number>) => Object.values(v).reduce((a, b) => a + b, 0) === 100;

export const HealthClientWeightsSchema = z
  .object({
    engagement: weight,
    billing: weight,
    subscription: weight,
    adoption: weight,
    portal: weight,
    support: weight,
  })
  .refine(sums100, { message: 'Los pesos de los clientes deben sumar 100' });

export const HealthTrialWeightsSchema = z
  .object({
    facility: weight,
    units: weight,
    customer: weight,
    contract: weight,
    invoice: weight,
    team: weight,
  })
  .refine(sums100, { message: 'Los pesos de las pruebas deben sumar 100' });

export const UpdatePlatformHealthSettingsSchema = z.object({
  clientWeights: HealthClientWeightsSchema.optional(),
  trialWeights: HealthTrialWeightsSchema.optional(),
  /** Puntos de caída (frente a la foto de hace una semana) que disparan el aviso. */
  dropAlertPoints: z.number().int().min(1).max(100).optional(),
  /** Consumo anómalo: N veces la media de los 3 meses anteriores. */
  anomalyMultiplier: z.number().min(1.5).max(50).optional(),
  anomalyMinEmails: z.number().int().min(0).max(10_000_000).optional(),
  anomalyMinAiUsd: z.number().min(0).max(100_000).optional(),
  anomalyMinStorageMb: z.number().int().min(0).max(10_000_000).optional(),
});
export type UpdatePlatformHealthSettingsInput = z.infer<typeof UpdatePlatformHealthSettingsSchema>;

export interface AdminPlatformHealthSettingsDto {
  clientWeights: HealthClientWeights;
  trialWeights: HealthTrialWeights;
  dropAlertPoints: number;
  anomalyMultiplier: number;
  anomalyMinEmails: number;
  anomalyMinAiUsd: number;
  anomalyMinStorageMb: number;
  updatedAt: string | null;
}

/** Lee unos pesos guardados (JSON) y completa con los de por defecto lo que falte. */
export function parseHealthWeights<K extends string>(
  raw: unknown,
  defaults: Record<K, number>,
): Record<K, number> {
  const out = { ...defaults };
  if (!raw || typeof raw !== 'object') return out;
  const candidate = { ...defaults };
  for (const k of Object.keys(defaults) as K[]) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) candidate[k] = Math.round(v);
  }
  return Object.values<number>(candidate).reduce((a, b) => a + b, 0) === 100 ? candidate : out;
}

// --- Riesgo de baja y probabilidad de pago ------------------------------------

export type TenantChurnRiskLevel = 'high' | 'medium' | 'low';

export const CHURN_RISK_LABELS: Record<TenantChurnRiskLevel, string> = {
  high: 'Riesgo alto',
  medium: 'Riesgo medio',
  low: 'Riesgo bajo',
};

/**
 * Riesgo de baja de un cliente según su puntuación y su tendencia:
 *  - alto: puntuación por debajo de 50, o una caída de 15 puntos o más;
 *  - medio: por debajo de 75, o una caída de 5 puntos o más;
 *  - bajo: el resto.
 */
export function churnRiskOf(score: number, trend: number | null): TenantChurnRiskLevel {
  const drop = trend !== null && trend < 0 ? -trend : 0;
  if (score < 50 || drop >= 15) return 'high';
  if (score < 75 || drop >= 5) return 'medium';
  return 'low';
}

export type PayProbabilityLevel = 'high' | 'medium' | 'low';

export const PAY_PROBABILITY_LABELS: Record<PayProbabilityLevel, string> = {
  high: 'Probable',
  medium: 'Dudosa',
  low: 'Poco probable',
};

/**
 * Probabilidad (0-100) de que una prueba acabe pagando, según su activación y
 * los días que le quedan. La activación manda; con poca activación y pocos días
 * baja (ya no le da tiempo), y con tiempo por delante sube algo (aún puede).
 *  - Con un contrato firmado (`signedContract`) no baja de 40.
 */
export function payProbabilityOf(
  activation: number,
  daysLeft: number | null,
  signedContract = false,
): { pct: number; level: PayProbabilityLevel } {
  let p = activation;
  if (daysLeft !== null) {
    if (daysLeft <= 0) p = activation * 0.6;
    else if (daysLeft <= 3 && activation < 60) p = activation * 0.75;
    else if (daysLeft >= 14 && activation < 80) p = activation + 10;
  }
  if (signedContract) p = Math.max(p, 40);
  const pct = Math.max(0, Math.min(100, Math.round(p)));
  return { pct, level: pct >= 60 ? 'high' : pct >= 30 ? 'medium' : 'low' };
}

// --- Por qué y qué hacer --------------------------------------------------------

export type HealthActionKind =
  | 'email'
  | 'followup'
  | 'playbook'
  | 'review_billing'
  | 'review_payment'
  | 'answer_support'
  | 'onboarding_help';

export interface HealthSuggestedActionDto {
  kind: HealthActionKind;
  label: string;
  /** Título propuesto para el seguimiento o asunto del correo. */
  followupTitle: string;
}

/** Acción sugerida para el factor que más resta. */
export function suggestedActionFor(factorKey: string): HealthSuggestedActionDto {
  switch (factorKey) {
    case 'engagement':
      return {
        kind: 'email',
        label: 'Escribir',
        followupTitle: 'Su equipo apenas entra: escribirle para ver qué necesita',
      };
    case 'billing':
      return {
        kind: 'review_billing',
        label: 'Revisar facturación',
        followupTitle: 'Facturación atrasada: revisar con el cliente',
      };
    case 'subscription':
      return {
        kind: 'review_payment',
        label: 'Revisar el cobro',
        followupTitle: 'Suscripción con problemas de cobro: revisar',
      };
    case 'adoption':
      return {
        kind: 'followup',
        label: 'Ofrecer formación',
        followupTitle: 'Poco uso: ofrecer una sesión de formación',
      };
    case 'portal':
      return {
        kind: 'email',
        label: 'Proponer el área de clientes',
        followupTitle: 'Proponer que dé acceso al área de clientes a sus inquilinos',
      };
    case 'support':
      return {
        kind: 'answer_support',
        label: 'Responder tickets',
        followupTitle: 'Tickets sin responder: contestar',
      };
    case 'team':
      return {
        kind: 'email',
        label: 'Escribir',
        followupTitle: 'Prueba sin actividad: escribirle',
      };
    case 'contract':
    case 'invoice':
    case 'customer':
      return {
        kind: 'onboarding_help',
        label: 'Ofrecer ayuda para el primer contrato',
        followupTitle: 'Ofrecer ayuda para su primer contrato',
      };
    default:
      return {
        kind: 'onboarding_help',
        label: 'Ofrecer ayuda para arrancar',
        followupTitle: 'Ofrecer ayuda para dar de alta su local y sus trasteros',
      };
  }
}

/** El factor que más puntos le quita (lo que pierde por peso) y qué hacer. */
export interface HealthMainDragDto {
  key: string;
  label: string;
  /** Puntos de la puntuación final que se pierden por este factor. */
  lostPoints: number;
  detail: string;
  action: HealthSuggestedActionDto;
}

export function mainDragOf(
  factors: {
    key: string;
    label: string;
    score: number;
    weight: number;
    counted: boolean;
    detail: string;
  }[],
): HealthMainDragDto | null {
  const counted = factors.filter((f) => f.counted && f.weight > 0);
  const total = counted.reduce((a, f) => a + f.weight, 0);
  if (total <= 0) return null;
  let best: (typeof counted)[number] | null = null;
  let bestLost = 0;
  for (const f of counted) {
    const lost = ((100 - f.score) * f.weight) / total;
    if (lost > bestLost) {
      best = f;
      bestLost = lost;
    }
  }
  if (!best || bestLost < 1) return null;
  return {
    key: best.key,
    label: best.label,
    lostPoints: Math.round(bestLost),
    detail: best.detail,
    action: suggestedActionFor(best.key),
  };
}

// --- Previsión simple -------------------------------------------------------------

/**
 * Tendencia lineal (mínimos cuadrados) de una serie y sus `ahead` valores
 * siguientes (nunca negativos). Con menos de 2 puntos repite el último.
 */
export function linearForecast(values: number[], ahead: number): number[] {
  const n = values.length;
  if (n === 0) return Array.from({ length: ahead }, () => 0);
  if (n === 1) return Array.from({ length: ahead }, () => values[0]!);
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((y, x) => {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  });
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;
  return Array.from({ length: ahead }, (_, i) =>
    Math.max(0, Math.round(intercept + slope * (n + i))),
  );
}

/**
 * ¿Es anómalo un consumo? Por encima del mínimo y más de `multiplier` veces la
 * media de los meses anteriores (sin media —es nuevo—, basta con pasar el
 * mínimo).
 */
export function isAnomalous(
  value: number,
  previousAverage: number,
  multiplier: number,
  minimum: number,
): boolean {
  if (value <= minimum) return false;
  if (previousAverage <= 0) return true;
  return value > previousAverage * multiplier;
}

// --- Historial de salud -----------------------------------------------------------

export interface AdminHealthHistoryPointDto {
  /** «AAAA-MM-DD» (diaria) o «AAAA-MM» (mensual). */
  date: string;
  label: string;
  score: number;
  level: string;
}

export interface AdminTenantHealthHistoryDto {
  tenantId: string;
  /** Una por mes (foto del mes), hasta 12. */
  monthly: AdminHealthHistoryPointDto[];
  /** Una por día en los últimos 90 días (las que haya). */
  daily: AdminHealthHistoryPointDto[];
  /** Mayor caída frente a la foto de una semana antes en el periodo diario. */
  biggestDrop: { date: string; points: number } | null;
}

// --- Candidatos a vender --------------------------------------------------------

export type UpgradeReasonKind = 'taps_limit' | 'near_limit' | 'outside_plan' | 'interest';

export interface AdminUpgradeSuggestionDto {
  type: 'plan' | 'addon';
  /** Id del plan o del extra. */
  id: string;
  slug: string | null;
  name: string;
  /** Lo que sumaría al mes sin IVA. */
  extraMonthly: number;
  /** El extra activa una función (admite prueba gratis). */
  trialable: boolean;
}

export interface AdminUpgradeCandidateDto {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  planSlug: string | null;
  planName: string | null;
  salesRepId: string | null;
  salesRepName: string | null;
  tags: string[];
  /** Lo que paga hoy al mes sin IVA. */
  monthlyPaid: number;
  reasons: { kind: UpgradeReasonKind; detail: string }[];
  suggestions: AdminUpgradeSuggestionDto[];
  /** Ingreso extra estimado al mes sin IVA (la mejor sugerencia). */
  estimatedExtraMonthly: number;
  /** Última propuesta enviada (extra o cuota) en 90 días, o null. */
  lastOfferAt: string | null;
}

export interface AdminUpgradeCandidatesDto {
  candidates: AdminUpgradeCandidateDto[];
  /** Suma de los ingresos extra estimados (sin IVA, al mes). */
  totalEstimatedMonthly: number;
}

// --- Matriz función × plan y retención ------------------------------------------

export interface AdminFeaturePlanCellDto {
  using: number;
  withAccess: number;
}

export interface AdminFeatureMatrixRowDto {
  feature: TenantFeature;
  label: string;
  /** Por slug de plan. */
  byPlan: Record<string, AdminFeaturePlanCellDto>;
  using: number;
  withAccess: number;
}

export interface AdminFeatureRetentionDto {
  feature: TenantFeature;
  label: string;
  /** Clientes (que pagaron en los 12 meses) que la usaron / que no. */
  usedCount: number;
  notUsedCount: number;
  /** % que se dio de baja en 12 meses entre los que la usaron / los que no. */
  usedChurnPct: number | null;
  notUsedChurnPct: number | null;
  /** false = poco histórico (menos de 5 en algún grupo o menos de 3 bajas). */
  enoughData: boolean;
}

export interface AdminAdoptionInsightsDto {
  plans: { slug: string; name: string }[];
  matrix: AdminFeatureMatrixRowDto[];
  retention: AdminFeatureRetentionDto[];
  /** Funciones que casi nadie usa (menos del 10 % de quien la tiene, o 1 o ninguno). */
  rarelyUsed: { feature: TenantFeature; label: string; using: number; withAccess: number }[];
  /** Bajas de clientes que pagaban en los últimos 12 meses (base del churn). */
  churnedLast12m: number;
}

// --- Evolución del uso --------------------------------------------------------------

export interface AdminUsageMonthDto {
  /** «AAAA-MM». */
  month: string;
  label: string;
  emails: number;
  whatsapp: number;
  aiCalls: number;
  aiCostUsd: number;
  /** null si ese mes no se midió. */
  storageBytes: number | null;
}

export interface AdminUsageEvolutionDto {
  tenantId: string | null;
  months: AdminUsageMonthDto[];
  /** Almacenamiento previsto (tendencia lineal) en los próximos meses. */
  storageForecast: { month: string; label: string; bytes: number }[];
  /** Crecimiento medio mensual del almacenamiento en los meses medidos (bytes). */
  storageMonthlyGrowth: number | null;
}

// --- Acciones en lote ---------------------------------------------------------------

export const AdminBulkFollowupsSchema = z.object({
  tenantIds: z.array(z.string().uuid()).min(1).max(500),
  title: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)'),
  assignedToId: z.string().uuid().nullable().optional(),
});
export type AdminBulkFollowupsInput = z.infer<typeof AdminBulkFollowupsSchema>;

export interface AdminBulkFollowupsResultDto {
  created: number;
  /** Ids que no existen (o están borrados). */
  skipped: number;
}

import { z } from 'zod';

/**
 * Mejoras de Métricas y Finanzas del panel super admin: desglose del MRR,
 * estados de cliente, retención en dinero, escenarios de previsión y su
 * precisión, concentración de ingresos, series por plan/extra/forma de
 * cobro/comercial, desglose de cifras por tenant, IVA trimestral, margen,
 * coste de adquisición, caja del mes y anotaciones de los gráficos.
 *
 * Funciones puras (con vitest) para los cálculos que no dependen de la BD.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

// --- Cálculos puros -----------------------------------------------------------

/** Percentil `p` (0-1) con interpolación lineal; null si no hay datos. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (pos - lo);
}

/**
 * Proyecta el MRR `horizon` meses: cada mes la base se multiplica por el NRR
 * (si lo hay) y se le suman las altas medias. Nunca baja de 0.
 */
export function projectMrr(
  currentMrr: number,
  horizon: number,
  newMrr: number,
  nrrPct: number | null,
): number[] {
  const out: number[] = [];
  let mrr = currentMrr;
  for (let i = 0; i < horizon; i++) {
    mrr = nrrPct !== null ? mrr * (nrrPct / 100) + newMrr : mrr + newMrr;
    out.push(round2(Math.max(0, mrr)));
  }
  return out;
}

/** Comisión estimada de una pasarela: % del importe + fijo por cobro. */
export function gatewayFee(amount: number, pct: number, fixed: number): number {
  if (amount <= 0) return 0;
  return round2((amount * pct) / 100 + fixed);
}

export interface ConcentrationShares {
  top1Pct: number;
  top5Pct: number;
  top10Pct: number;
  /** Índice de Herfindahl (Σ cuota² × 10 000): 10 000 = un solo cliente. */
  hhi: number;
}

/** Peso de los mayores clientes en el MRR. */
export function concentrationShares(mrrs: number[]): ConcentrationShares {
  const values = mrrs.filter((v) => v > 0).sort((a, b) => b - a);
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return { top1Pct: 0, top5Pct: 0, top10Pct: 0, hhi: 0 };
  const top = (n: number) => round2((values.slice(0, n).reduce((s, v) => s + v, 0) / total) * 100);
  const hhi = Math.round(values.reduce((s, v) => s + (v / total) ** 2, 0) * 10_000);
  return { top1Pct: top(1), top5Pct: top(5), top10Pct: top(10), hhi };
}

/** Meses para recuperar el coste de adquisición; null si no se puede calcular. */
export function paybackMonths(
  cac: number | null,
  arpa: number,
  grossMarginPct: number | null,
): number | null {
  if (cac === null || cac <= 0) return cac === 0 ? 0 : null;
  const margin = grossMarginPct === null ? 1 : grossMarginPct / 100;
  const monthly = arpa * margin;
  if (monthly <= 0) return null;
  return round2(cac / monthly);
}

/** Trimestre natural (1-4) de un mes (1-12). */
export function quarterOfMonth(month: number): 1 | 2 | 3 | 4 {
  return (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
}

// --- 1. Desglose del MRR -----------------------------------------------------

export interface AdminMrrBreakdownDto {
  /** MRR total sin IVA (= plan mensual + anual repartido + extras). */
  total: number;
  /** Cuota del plan de quien paga cada mes, con su descuento. */
  planMonthly: number;
  /** Cuota anual repartida entre 12, con su descuento. */
  planYearly: number;
  /** Extras activos. */
  addons: number;
  /** Lo que se deja de ingresar al mes por descuentos (cupones y a mano). */
  discounts: number;
  /** Clientes que pagan por meses y por años. */
  monthlyTenants: number;
  yearlyTenants: number;
  /** Clientes con descuento. */
  discountedTenants: number;
}

// --- 2. Estados de cliente -----------------------------------------------------

export const CLIENT_STATES = [
  'trial',
  'paying',
  'past_due',
  'read_only',
  'churned',
  'free',
] as const;
export type AdminClientState = (typeof CLIENT_STATES)[number];

export const CLIENT_STATE_LABELS: Record<AdminClientState, string> = {
  trial: 'En prueba',
  paying: 'Pagando',
  past_due: 'Pago atrasado',
  read_only: 'Solo lectura',
  churned: 'De baja',
  free: 'Activos sin cuota',
};

export interface AdminClientStateDto {
  state: AdminClientState;
  count: number;
  /**
   * MRR sin IVA. `real` = lo que aportan (pagando y atrasado); `potential` =
   * lo que pagarían (prueba y solo lectura); `lost` = el último que aportaban
   * (de baja).
   */
  mrr: number;
  mrrKind: 'real' | 'potential' | 'lost';
}

export interface AdminClientStatesMonthDto {
  label: string;
  /** «AAAA-MM». */
  month: string;
  trial: number;
  paying: number;
  pastDue: number;
  readOnly: number;
  /** Bajas acumuladas de clientes que pagaban hasta ese mes. */
  churned: number;
  /** MRR sin IVA de los que pagan (también atrasados) ese mes. */
  payingMrr: number;
}

export interface AdminClientStatesDto {
  states: AdminClientStateDto[];
  /** Evolución mes a mes (el último es el mes en curso). */
  evolution: AdminClientStatesMonthDto[];
}

// --- 4. Previsión: escenarios y precisión -------------------------------------

export interface AdminForecastScenarioDto {
  key: 'prudent' | 'expected' | 'optimistic';
  label: string;
  /** Altas (nuevas + reactivaciones) por mes que supone. */
  newMrr: number;
  /** NRR mensual que supone (%); null sin datos. */
  nrr: number | null;
  points: { label: string; mrr: number }[];
}

export interface AdminForecastAccuracyDto {
  /** Mes previsto, «dic 25». */
  label: string;
  /** «AAAA-MM». */
  month: string;
  /** MRR real al cierre de ese mes (sin IVA). */
  actual: number;
  /** Previsiones hechas 1, 2 y 3 meses antes (si las hay). */
  forecasts: {
    monthsAhead: number;
    expected: number;
    prudent: number;
    optimistic: number;
    /** (previsto − real) / real × 100; null si el real es 0. */
    errorPct: number | null;
    /** El real cayó entre el prudente y el optimista. */
    withinRange: boolean;
  }[];
}

// --- 8. Concentración ---------------------------------------------------------

export interface AdminConcentrationDto extends ConcentrationShares {
  totalMrr: number;
  payingTenants: number;
  /** Umbral del aviso (% del MRR de un solo cliente). */
  thresholdPct: number;
  /** Los 10 clientes con más MRR. */
  top: { tenantId: string; name: string; slug: string; mrr: number; sharePct: number }[];
  /** Clientes por encima del umbral. */
  overThreshold: number;
}

// --- 9. Series de ingresos ----------------------------------------------------

export const REVENUE_SERIES_BY = ['plan', 'addon', 'source', 'rep'] as const;
export type AdminRevenueSeriesBy = (typeof REVENUE_SERIES_BY)[number];

export interface AdminRevenueSeriesDto {
  by: AdminRevenueSeriesBy;
  /** `mrr` (sin IVA, de los snapshots) o `collected` (cobrado neto, con IVA). */
  basis: 'mrr' | 'collected';
  labels: string[];
  /** «AAAA-MM» de cada etiqueta. */
  months: string[];
  series: { key: string; label: string; values: number[] }[];
  note: string | null;
}

// --- 10. Desglose de una cifra -----------------------------------------------

export const BREAKDOWN_METRICS = [
  'paying',
  'active',
  'trial',
  'past_due',
  'read_only',
  'suspended',
  'cancelled',
  'free',
  'signups',
  'churned',
  'plan',
  'movement',
  'cohort',
  'concentration',
] as const;
export type AdminBreakdownMetric = (typeof BREAKDOWN_METRICS)[number];

export const MRR_MOVEMENT_KINDS = [
  'new',
  'expansion',
  'reactivation',
  'contraction',
  'churn',
] as const;
export type AdminMrrMovementKind = (typeof MRR_MOVEMENT_KINDS)[number];

export interface AdminBreakdownRowDto {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  planName: string | null;
  /** MRR sin IVA que corresponde a la cifra (el actual, el del mes o el cambio). */
  mrr: number;
  /** Algo más para entender la fila (fecha de alta, de baja, cambio…). */
  detail: string | null;
}

export interface AdminBreakdownDto {
  metric: AdminBreakdownMetric;
  title: string;
  rows: AdminBreakdownRowDto[];
  totalMrr: number;
}

// --- 14. Anotaciones -----------------------------------------------------------

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

export const CreateMetricAnnotationSchema = z.object({
  date: isoDay,
  text: z.string().trim().min(1, 'Escribe la anotación').max(120),
});
export type CreateMetricAnnotationInput = z.infer<typeof CreateMetricAnnotationSchema>;

export const UpdateMetricAnnotationSchema = CreateMetricAnnotationSchema.partial();
export type UpdateMetricAnnotationInput = z.infer<typeof UpdateMetricAnnotationSchema>;

export interface AdminMetricAnnotationDto {
  id: string;
  /** «AAAA-MM-DD». */
  date: string;
  /** «AAAA-MM» del mes (para pintarla en los gráficos mensuales). */
  month: string;
  text: string;
  authorName: string | null;
  createdAt: string;
}

// --- 14. Comparación con el año pasado ----------------------------------------

export interface AdminLastYearDto {
  /** MRR sin IVA del mismo mes del año pasado (snapshots). */
  mrr: number | null;
  payingTenants: number | null;
  signupsThisMonth: number;
  cancellationsThisMonth: number;
}

// --- 5. IVA trimestral ----------------------------------------------------------

export interface AdminVatQuarterDto {
  quarter: 1 | 2 | 3 | 4;
  /** «1T 2026». */
  label: string;
  invoices: number;
  base: number;
  tax: number;
  total: number;
  /** Por tipo de IVA. */
  byRate: { rate: number; base: number; tax: number; total: number }[];
}

export interface AdminVatQuarterlyDto {
  year: number;
  quarters: AdminVatQuarterDto[];
  totals: { invoices: number; base: number; tax: number; total: number };
}

// --- 6. Margen ------------------------------------------------------------------

const money = (max: number) => z.number().min(0).max(max);

export const UpdateFinanceSettingsSchema = z.object({
  stripeFeePct: money(20).optional(),
  stripeFeeFixed: money(10).optional(),
  redsysFeePct: money(20).optional(),
  redsysFeeFixed: money(10).optional(),
  sepaFeePct: money(20).optional(),
  sepaFeeFixed: money(10).optional(),
  manualFeePct: money(20).optional(),
  manualFeeFixed: money(10).optional(),
  usdEurRate: z.number().min(0.1).max(10).optional(),
  emailCost: money(1).optional(),
});
export type UpdateFinanceSettingsInput = z.infer<typeof UpdateFinanceSettingsSchema>;

export interface AdminFinanceSettingsDto {
  stripeFeePct: number;
  stripeFeeFixed: number;
  redsysFeePct: number;
  redsysFeeFixed: number;
  sepaFeePct: number;
  sepaFeeFixed: number;
  manualFeePct: number;
  manualFeeFixed: number;
  usdEurRate: number;
  emailCost: number;
  updatedAt: string | null;
}

export interface AdminMarginMonthDto {
  label: string;
  month: string;
  /** Cobrado neto sin IVA. */
  revenue: number;
  gatewayFees: number;
  aiCost: number;
  emailCost: number;
  salesCommissions: number;
  /** revenue − todos los costes. */
  margin: number;
  marginPct: number | null;
}

export interface AdminTenantMarginDto {
  tenantId: string;
  name: string;
  slug: string;
  revenue: number;
  costs: number;
  margin: number;
  marginPct: number | null;
}

export interface AdminMarginDto {
  months: number;
  settings: AdminFinanceSettingsDto;
  monthly: AdminMarginMonthDto[];
  totals: Omit<AdminMarginMonthDto, 'label' | 'month'>;
  /** Margen bruto (sin las comisiones de los comerciales), en %. */
  grossMarginPct: number | null;
  /** Correos contados en el periodo (de la plataforma y de los tenants). */
  emailsSent: number;
  topTenants: AdminTenantMarginDto[];
  worstTenants: AdminTenantMarginDto[];
}

// --- 7. Coste de adquisición ------------------------------------------------

export const UpdateMarketingSpendSchema = z.object({
  amount: money(10_000_000),
  note: z.string().trim().max(200).nullable().optional(),
});
export type UpdateMarketingSpendInput = z.infer<typeof UpdateMarketingSpendSchema>;

export interface AdminAcquisitionMonthDto {
  label: string;
  month: string;
  /** Clientes que pagaron por primera vez ese mes. */
  newPaying: number;
  salesSpend: number;
  marketingSpend: number;
  /** (comercial + marketing) / nuevos que pagan; null sin nuevos. */
  cac: number | null;
}

export interface AdminAcquisitionDto {
  months: number;
  monthly: AdminAcquisitionMonthDto[];
  totals: { newPaying: number; salesSpend: number; marketingSpend: number; cac: number | null };
  /** MRR / clientes que pagan ahora, sin IVA. */
  arpa: number;
  grossMarginPct: number | null;
  /** CAC / (ARPA × margen bruto). */
  paybackMonths: number | null;
}

// --- 11. Exportar ---------------------------------------------------------------

export const FINANCE_CSV_KINDS = [
  'monthly',
  'providers',
  'vat',
  'margin',
  'reconciliation',
] as const;
export type AdminFinanceCsvKind = (typeof FINANCE_CSV_KINDS)[number];

// --- 12. Conciliación por cobro ----------------------------------------------

export interface AdminReconciliationPaymentDto {
  id: string;
  tenantId: string;
  tenantName: string;
  amount: number;
  provider: string;
  paidAt: string;
}

export interface AdminReconciliationInvoiceDto {
  id: string;
  fullNumber: string;
  tenantId: string;
  tenantName: string;
  total: number;
  issuedAt: string;
}

// --- 13. Caja del mes -------------------------------------------------------------

export interface AdminCashMonthDto {
  /** «noviembre de 2026». */
  label: string;
  /** Cobrado neto este mes (con IVA). */
  collected: number;
  /** Lo que queda por cobrar este mes según los cargos previstos (con IVA). */
  expectedRest: number;
  /** Cuotas vencidas sin cobrar (con IVA). */
  overdue: number;
  /** collected + expectedRest. */
  projected: number;
  /** Objetivo de cobro mensual (con IVA). */
  target: number | null;
  /** collected / objetivo, en %. */
  collectedPct: number | null;
  /** projected / objetivo, en %. */
  projectedPct: number | null;
}

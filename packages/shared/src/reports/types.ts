import type { ReportFormatValue, ReportGeneratorCode, ReportStatusValue } from './schemas';

export interface ReportRunDto {
  id: string;
  generatorCode: ReportGeneratorCode | string;
  format: ReportFormatValue;
  status: ReportStatusValue;
  params: Record<string, unknown>;
  downloadUrl: string | null;
  fileBytes: number | null;
  errorMessage: string | null;
  triggeredByUserId: string | null;
  triggeredByName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ReportGeneratorCatalogEntry {
  code: ReportGeneratorCode | string;
  name: string;
  description: string;
  formats: ReportFormatValue[];
  paramsSchema: Record<string, ReportParamSchema>;
}

export interface ReportParamSchema {
  label: string;
  type: 'date' | 'period' | 'select' | 'text' | 'number';
  required: boolean;
  options?: { value: string; label: string }[];
}

// ============================================================================
// Analytics DTOs
// ============================================================================

export interface OccupancyKpiDto {
  totalUnits: number;
  occupiedUnits: number;
  reservedUnits: number;
  availableUnits: number;
  /** % units alquilados / total. */
  physicalOccupancy: number;
  /** MRR real (sum priceMonthly contratos active) / MRR potencial (sum default × total). */
  economicOccupancy: number;
  mrrActual: number;
  mrrPotential: number;
  perFacility: { facilityId: string; facilityName: string; total: number; occupied: number }[];
}

export interface ChurnKpiDto {
  /** Periodo agregado. */
  months: { yearMonth: string; activeAtStart: number; ended: number; churnRate: number }[];
}

export interface AgingKpiDto {
  /** Total pendiente en cada tramo en EUR. */
  buckets: { range: '0-30' | '30-60' | '60-90' | '+90'; amount: number; invoiceCount: number }[];
  totalOutstanding: number;
}

export interface LeadsFunnelKpiDto {
  totals: { new: number; contacted: number; qualified: number; won: number; lost: number };
  conversion: {
    newToContacted: number;
    contactedToQualified: number;
    qualifiedToWon: number;
  };
  bySource: { source: string; count: number }[];
}

export interface CustomerStatsKpiDto {
  /** Inquilinos activos (no anonimizados ni soft-deleted). */
  total: number;
  /** Inquilinos con al menos un contrato activo (generan ingresos). */
  withActiveContract: number;
  /** Altas desde el día 1 del mes actual. */
  newThisMonth: number;
}

export interface RevenueKpiDto {
  /** MRR real (suma de cuotas efectivas de contratos activos/ending). */
  mrr: number;
  totalUnits: number;
  occupiedUnits: number;
  /** Revenue Per Available Unit: MRR / total de trasteros. */
  revPau: number;
  /** Duración media de estancia en días (contratos firmados). */
  avgLengthOfStayDays: number;
  /** LTV medio: total facturado (pagado) por inquilino con facturación. */
  avgCustomerLtv: number;
}

// ============================================================================
// Insights: churn risk + dynamic pricing (heurísticos, read-only)
// ============================================================================

export type ChurnRiskLevel = 'low' | 'medium' | 'high';

export interface ChurnRiskItemDto {
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  unitCode: string;
  facilityName: string;
  priceMonthly: number;
  /** Puntuación 0-100 (mayor = más riesgo de baja). */
  score: number;
  level: ChurnRiskLevel;
  /** Señales legibles que contribuyen al riesgo. */
  factors: string[];
}

export interface ChurnRiskKpiDto {
  summary: { high: number; medium: number; low: number; total: number };
  /** Contratos ordenados por riesgo descendente (los `low` se omiten del detalle). */
  items: ChurnRiskItemDto[];
}

export type PricingAction = 'raise' | 'lower' | 'hold';

export interface PricingSuggestionItemDto {
  unitTypeId: string;
  unitTypeName: string;
  totalUnits: number;
  occupiedUnits: number;
  /** % ocupación física de este tipo (0-100). */
  occupancy: number;
  /** Precio mensual de referencia (default del unit type). */
  currentPrice: number;
  /** Precio sugerido según la ocupación. */
  suggestedPrice: number;
  /** Variación sugerida en % (+/-). */
  changePct: number;
  action: PricingAction;
  rationale: string;
}

export interface PricingSuggestionsDto {
  items: PricingSuggestionItemDto[];
}

/** Resultado de aplicar una sugerencia de precio a un tipo de trastero. */
export interface ApplyPricingResultDto {
  unitTypeId: string;
  previousPrice: number;
  newPrice: number;
}

// ============================================================================
// Forecasting de ocupación e ingresos (proyección heurística por tendencia)
// ============================================================================

export interface RevenueForecastPointDto {
  /** Mes proyectado (YYYY-MM). */
  yearMonth: string;
  projectedActiveContracts: number;
  projectedMrr: number;
  /** Ocupación física proyectada (0-1). */
  projectedOccupancy: number;
}

/** Ingresos reales de un mes: facturado (emitido) y cobrado en ese mes. */
export interface MonthlyRevenuePointDto {
  /** Mes (YYYY-MM). */
  yearMonth: string;
  /** Etiqueta corta para el eje (p. ej. "jun 25"). */
  label: string;
  /** Total facturado: facturas emitidas en el mes (por fecha de emisión). */
  invoiced: number;
  /** Total cobrado: pagos con éxito en el mes (por fecha de cobro). */
  collected: number;
}

export interface MonthlyRevenueKpiDto {
  points: MonthlyRevenuePointDto[];
}

export interface RevenueForecastDto {
  current: {
    activeContracts: number;
    mrr: number;
    totalUnits: number;
    /** Ocupación física actual (0-1). */
    occupancy: number;
  };
  /** Supuestos del modelo, derivados de los meses recientes. */
  assumptions: {
    /** Tasa media de baja mensual (0-1). */
    monthlyChurnRate: number;
    /** Altas medias de contratos al mes. */
    avgMonthlyNewContracts: number;
    /** Valor medio por contrato (€/mes). */
    avgContractValue: number;
    /** Nº de meses de histórico usados para las medias. */
    trailingMonths: number;
  };
  points: RevenueForecastPointDto[];
}

// --- Sugerencia de precio por trastero individual (revenue management v1) ---
/** Un factor que contribuye a la sugerencia (transparencia). `contribution` en %. */
export interface UnitPricingFactorDto {
  label: string;
  detail: string;
  contribution: number;
}

/** Sugerencia de precio para UN trastero disponible (ocupación de su dimensión + días vacío). */
export interface UnitPricingSuggestionDto {
  unitId: string;
  code: string;
  unitTypeName: string | null;
  facilityId: string;
  facilityName: string;
  /** Ocupación (%) de trasteros del mismo tipo en el mismo local. */
  occupancyPct: number;
  /** Días que este trastero lleva disponible (stock parado). */
  daysVacant: number;
  currentPrice: number;
  suggestedPrice: number;
  /** Cambio neto sugerido en % (acotado). */
  changePct: number;
  action: 'raise' | 'lower' | 'hold';
  factors: UnitPricingFactorDto[];
}

export interface UnitPricingSuggestionsDto {
  items: UnitPricingSuggestionDto[];
}

export interface ApplyUnitPricingResultDto {
  unitId: string;
  previousPrice: number;
  newPrice: number;
}

// --- Sugerencias de hoy (insights accionables del dashboard) ---
export type SuggestedActionCategory = 'retention' | 'pricing' | 'collections' | 'renewal';
export type SuggestedActionPriority = 'high' | 'medium';

/** Una acción concreta sugerida al operador, con enlace directo al recurso. */
export interface SuggestedActionDto {
  id: string;
  category: SuggestedActionCategory;
  priority: SuggestedActionPriority;
  title: string;
  detail: string;
  /** Ruta del panel a la que lleva la acción. */
  href: string;
  cta: string;
}

export interface SuggestedActionsDto {
  actions: SuggestedActionDto[];
}

/**
 * Comparativa anónima de una métrica frente al sector: agregados del mercado
 * (mediana, p25, p75) + el valor del propio tenant y su percentil.
 */
export interface BenchmarkMetricDto {
  /** Mediana del sector (p50). */
  median: number;
  /** Percentil 25 del sector. */
  p25: number;
  /** Percentil 75 del sector. */
  p75: number;
  /** Valor del tenant que consulta. */
  mine: number;
  /** Percentil (0-100) del tenant: % de operadores del sector por debajo de su valor. */
  myPercentile: number;
}

/**
 * Benchmarking anónimo entre operadores de self-storage. NUNCA expone datos
 * individuales de otros tenants: sólo agregados del sector + los valores del
 * propio tenant. Si la muestra es menor que el mínimo, `available:false`
 * (protege el anonimato).
 */
export interface BenchmarkDto {
  available: boolean;
  /** Número de operadores anónimos incluidos en la muestra. */
  sampleSize: number;
  /** % de trasteros ocupados sobre el total. */
  occupancy?: BenchmarkMetricDto;
  /** Precio medio mensual por trastero (€). */
  price?: BenchmarkMetricDto;
  /** Precio medio por m² (€/m²·mes). */
  pricePerSqm?: BenchmarkMetricDto;
}

/** Rendimiento de la web pública por fuente (Web Premium). */
export interface WebPerformanceSourceDto {
  /** Clave de la fuente (`web` = formulario de contacto, `widget` = embebido). */
  source: string;
  /** Etiqueta legible. */
  label: string;
  /** Leads captados por esa fuente en el rango. */
  leads: number;
  /** De esos, cuántos acabaron en contrato (ganados). */
  won: number;
  /** MRR (€/mes) de los contratos vivos originados por esos leads. */
  mrr: number;
}

export interface WebPerformanceDto {
  /** Desde/hasta del rango (YYYY-MM-DD). */
  from: string;
  to: string;
  /** Total de leads de la web (todas las fuentes web) en el rango. */
  totalLeads: number;
  /** Total de leads ganados (convertidos en contrato). */
  totalWon: number;
  /** % de conversión leads→contrato. */
  conversionRate: number;
  /** MRR total (€/mes) atribuido a la web. */
  totalMrr: number;
  /** Desglose por fuente. */
  bySource: WebPerformanceSourceDto[];
}

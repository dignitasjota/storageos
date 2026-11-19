import type { ReportFormatValue, ReportGeneratorCode, ReportStatusValue } from './schemas';

export interface ReportRunDto {
  id: string;
  generatorCode: ReportGeneratorCode | string;
  format: ReportFormatValue;
  status: ReportStatusValue;
  params: Record<string, unknown>;
  /**
   * El fichero NO viaja aquí como URL permanente (bucket privado, sin
   * firmar): pedir `GET /reports/:id/download` cuando `true` da una URL
   * firmada de corta duración.
   */
  hasDownload: boolean;
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
  /**
   * MRR real (cuotas de los contratos vivos menos su descuento) / MRR potencial
   * (precio de cada trastero que se puede alquilar: libre, reservado u ocupado).
   * Null sin permiso para ver el dinero (facturas y cobros).
   */
  economicOccupancy: number | null;
  mrrActual: number | null;
  mrrPotential: number | null;
  /** Trasteros en mantenimiento o bloqueados (no se pueden alquilar). */
  outOfServiceUnits: number;
  /** Trasteros por cada estado. */
  byStatus: Record<string, number>;
  perFacility: {
    facilityId: string;
    facilityName: string;
    total: number;
    occupied: number;
    reserved: number;
    available: number;
    outOfService: number;
  }[];
}

export interface ChurnKpiDto {
  /** Periodo agregado. */
  months: {
    yearMonth: string;
    activeAtStart: number;
    /** Altas del mes (cuentan en la base: quien entra y se va el mismo mes es una baja). */
    started: number;
    ended: number;
    /** Bajas sobre los activos al empezar el mes más las altas del mes. */
    churnRate: number;
  }[];
}

export type AgingBucketRange = '0-30' | '30-60' | '60-90' | '+90';

export interface AgingKpiDto {
  /** Total pendiente en cada tramo en EUR. */
  buckets: { range: AgingBucketRange; amount: number; invoiceCount: number }[];
  totalOutstanding: number;
}

/** Lo emitido sin cobrar, separando lo vencido de lo que aún está en plazo. */
export interface ReceivablesDto {
  total: number;
  overdue: number;
  notDue: number;
  invoices: number;
  overdueInvoices: number;
  /** Lo vencido por antigüedad. */
  buckets: AgingKpiDto['buckets'];
}

export interface LeadsFunnelKpiDto {
  /** Contactos del periodo según su fase actual (cada contacto cuenta una vez). */
  totals: { new: number; contacted: number; qualified: number; won: number; lost: number };
  /** Contactos del periodo que llegaron al menos a esa fase (aunque luego avanzaran o se perdieran). */
  reached: { contacted: number; qualified: number; won: number };
  /** Total de contactos del periodo. */
  total: number;
  from: string;
  to: string;
  conversion: {
    newToContacted: number;
    contactedToQualified: number;
    qualifiedToWon: number;
  };
  bySource: { source: string; count: number }[];
  /** Perdidos del periodo por motivo (`unknown` = sin motivo, de antes de pedirlo). */
  lostReasons: { reason: string; count: number }[];
  /** Cuánto se tarda en atender y en cerrar los contactos del periodo. */
  timing: {
    /** Mediana de horas desde que llega hasta que se le contacta (null si nadie). */
    firstResponseHours: number | null;
    /** Contactos del periodo ya contactados (con su hora). */
    responded: number;
    /** Mediana de días desde que llega hasta que se gana. */
    daysToWin: number | null;
  };
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
  /** Valor medio por inquilino: lo cobrado de verdad (neto de devoluciones). */
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
  /** Trasteros del inquilino (separados por comas si tiene varios). */
  unitCode: string;
  facilityName: string;
  /** Lo que paga al mes entre todos sus trasteros; null sin permiso para ver el dinero. */
  priceMonthly: number | null;
  /** Contratos vivos del inquilino (el riesgo es por inquilino, no por contrato). */
  contractCount: number;
  /** Puntuación 0-100 (mayor = más riesgo de baja). */
  score: number;
  level: ChurnRiskLevel;
  /** Señales legibles que contribuyen al riesgo. */
  factors: string[];
  /** `ending` = ya pidió la baja (se le puede hacer una oferta de retención). */
  contractStatus: 'active' | 'ending';
  /** Último acceso al local con su código (null = nunca o sin control de accesos). */
  lastAccessAt: string | null;
  /** Teléfono del inquilino, para llamarle o escribirle por WhatsApp. */
  phone: string | null;
}

export interface ChurnRiskKpiDto {
  summary: {
    high: number;
    medium: number;
    low: number;
    total: number;
    /** Cuotas al mes de los inquilinos en riesgo alto y medio; null sin permiso. */
    atStakeMonthly: number | null;
  };
  /** Contratos ordenados por riesgo descendente (los `low` se omiten del detalle). */
  items: ChurnRiskItemDto[];
}

export type PricingAction = 'raise' | 'lower' | 'hold';
/** Cuánto respaldan los datos de la competencia el precio de mercado. */
export type PricingConfidence = 'high' | 'medium' | 'low';

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
  /** Precio de mercado del tamaño medio del tipo (sin IVA), null sin datos. */
  marketPrice: number | null;
  confidence: PricingConfidence;
  marketTrend: MarketTrendDto | null;
  /** Trasteros libres de este tipo en todos los locales (aplicar les cambia el precio). */
  availableUnitsAll: number;
}

/** Tendencia de precios de la competencia (informativa, no mueve la sugerencia). */
export interface MarketTrendDto {
  /** Variación mediana (%) entre la primera y la última revisión. */
  changePct: number;
  months: number;
  /** Trasteros de la competencia que la respaldan. */
  units: number;
}

export interface PricingSuggestionsDto {
  items: PricingSuggestionItemDto[];
}

/** Resultado de aplicar una sugerencia de precio a un tipo de trastero. */
export interface ApplyPricingResultDto {
  unitTypeId: string;
  previousPrice: number;
  newPrice: number;
  /** Trasteros libres de ese tipo a los que también se les ha cambiado el precio. */
  unitsUpdated: number;
}

// ============================================================================
// Forecasting de ocupación e ingresos (proyección heurística por tendencia)
// ============================================================================

export interface RevenueForecastPointDto {
  /** Mes proyectado (YYYY-MM). */
  yearMonth: string;
  projectedActiveContracts: number;
  /** Null sin permiso para ver el dinero. */
  projectedMrr: number | null;
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
    /** Null sin permiso para ver el dinero. */
    mrr: number | null;
    /** Trasteros que se pueden alquilar (sin los que están fuera de servicio). */
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
    /** Valor medio por contrato (€/mes); null sin permiso para ver el dinero. */
    avgContractValue: number | null;
    /** Nº de meses de histórico usados para las medias. */
    trailingMonths: number;
    /** Meses cerrados con actividad de verdad (si el negocio es más nuevo, menos). */
    historyMonths: number;
    /** La tendencia pasaba de los trasteros que hay y se ha cortado ahí. */
    cappedAtCapacity: boolean;
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
  /** Precio de mercado de su tamaño exacto (sin IVA), null sin datos de competencia. */
  marketPrice: number | null;
  /** Trasteros de la competencia que respaldan el precio de mercado. */
  marketReferences: number;
  confidence: PricingConfidence;
  /** Precio al que convendría llegar (puede necesitar varios cambios). */
  targetPrice: number;
  /** Por qué no se sugiere cambiar, si es el caso. */
  holdReason: string | null;
  /** Lleva mucho tiempo libre: mejor una promoción que bajar el precio del tamaño. */
  promotionHint: string | null;
  /** Tendencia de precios de la competencia cercana (null sin revisiones suficientes). */
  marketTrend: MarketTrendDto | null;
  /** Oferta activa de este trastero, si ya se creó una. */
  activeOffer: { promotionId: string; code: string; freeMonths: number; validUntil: string } | null;
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
export type SuggestedActionCategory =
  | 'retention'
  | 'pricing'
  | 'collections'
  | 'renewal'
  | 'competition';
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
  /** true si el orden y la redacción los ha afinado la IA (el tenant tiene el asistente). */
  aiEnhanced: boolean;
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

/**
 * Checklist de SEO on-page: agrega señales que ya existen en el producto
 * (horario, fotos, FAQ, testimonios, blog…) en una vista única accionable.
 * `base` aplica a cualquier tenant; `premium` solo es alcanzable con la
 * feature `web_premium` (se muestra igualmente, gated en el frontend).
 */
export interface SeoChecklistItemDto {
  id: string;
  label: string;
  /** Por qué importa para el SEO/conversión de la web pública. */
  description: string;
  done: boolean;
  /** Detalle opcional, p. ej. "2 de 3 locales sin horario". */
  detail: string | null;
  /** Ruta del panel donde se arregla. */
  href: string;
}

export interface SeoChecklistDto {
  hasWebPremium: boolean;
  base: SeoChecklistItemDto[];
  /** Vacío (no null) si el tenant no tiene `web_premium` — el frontend muestra el upsell. */
  premium: SeoChecklistItemDto[];
  baseScore: { done: number; total: number };
  premiumScore: { done: number; total: number };
}

// --- Estrategia de precios ---
export interface PricingStrategyDto {
  /** Ocupación objetivo (%). */
  targetOccupancy: number;
  /** Cambio máximo por vez (%). */
  maxStepPct: number;
  /** Días mínimos entre dos cambios de precio de un trastero. */
  minDaysBetweenChanges: number;
  facilities: { id: string; name: string; positioningPct: number }[];
  unitTypes: { id: string; name: string; minPrice: number | null; maxPrice: number | null }[];
}

// --- Efecto de los cambios de precio en la demanda ---
export interface PriceChangeEffectDto {
  unitId: string;
  code: string;
  unitTypeName: string | null;
  facilityName: string;
  changedAt: string;
  previousPrice: number;
  newPrice: number;
  changePct: number;
  /** manual | suggestion */
  source: string;
  /** Días que tardó en alquilarse tras el cambio (null si sigue libre). */
  daysToRentAfter: number | null;
  /** Días que lleva libre desde el cambio, si aún no se ha alquilado. */
  stillFreeDays: number | null;
  /** Mediana de días que tardaba en alquilarse ese tamaño en los 180 días anteriores. */
  baselineMedianDays: number | null;
  baselineRentals: number;
}

export interface PriceChangeEffectsSummaryDto {
  changes: number;
  rented: number;
  /** Media de días hasta alquilarse tras el cambio (solo los alquilados). */
  avgDaysAfter: number | null;
  /** Media de la referencia anterior de esos mismos cambios. */
  avgBaselineDays: number | null;
}

export interface PriceChangeEffectsDto {
  items: PriceChangeEffectDto[];
  raises: PriceChangeEffectsSummaryDto;
  lowers: PriceChangeEffectsSummaryDto;
}

// ---------------------------------------------------------------------------
// Avisos de competencia
// ---------------------------------------------------------------------------

export interface CompetitionPriceDropDto {
  competitorFacilityId: string;
  competitorName: string;
  competitorUnitId: string;
  areaM2: number;
  previousPrice: number;
  newPrice: number;
  /** El precio nuevo comparable con el tuyo: sin IVA, con seguro, alta y promoción. */
  comparablePrice: number;
  observedAt: string;
  /** Precio medio de tus trasteros de un tamaño parecido (±25 % de m², sin IVA). */
  myPrice: number;
}

export interface CompetitionAlertsDto {
  /** Competidores que toca revisar (su plazo, 30 días por defecto) o nunca comprobados. */
  stale: { id: string; name: string; lastReviewedAt: string | null }[];
  /** Bajadas de precio de los últimos 30 días en tamaños donde eres más caro. */
  priceDrops: CompetitionPriceDropDto[];
  /** Subidas de los últimos 30 días en tamaños donde eres más barato: margen para subir. */
  priceRises: CompetitionPriceDropDto[];
  /**
   * Competidores con el inventario completo sin ningún trastero libre de un
   * tamaño parecido a uno tuyo que sí tienes libre.
   */
  soldOut: {
    competitorFacilityId: string;
    competitorName: string;
    /** Tu tipo de trastero con libres. */
    unitTypeName: string;
    areaM2: number;
    myAvailable: number;
  }[];
}

// ---------------------------------------------------------------------------
// Tendencias: ocupación histórica, desglose de ingresos y cohortes
// ---------------------------------------------------------------------------

export interface OccupancyHistoryPointDto {
  yearMonth: string;
  totalUnits: number;
  occupiedUnits: number;
  occupancy: number;
  /** Cuotas de los trasteros alquilados ese mes; null sin permiso para ver el dinero. */
  mrr: number | null;
}

export interface OccupancyHistorySeriesDto {
  id: string;
  name: string;
  /** Ocupación (0-1) de cada mes, en el orden de `points`. */
  occupancy: number[];
}

/** Preventa de un local por abrir: trasteros reservados antes de la apertura. */
export interface PreOpeningFacilityDto {
  facilityId: string;
  facilityName: string;
  /** Fecha de apertura prevista (`YYYY-MM-DD`) o null si aún no hay. */
  openingDate: string | null;
  totalUnits: number;
  /** Trasteros con una reserva firmada (pagada o no). */
  reserved: number;
  /** De ellas, sin la primera mensualidad pagada. */
  unpaid: number;
  available: number;
  /** Cuotas (sin IVA) que empezarán a facturarse el día de apertura. */
  reservedMrr: number;
  /** Cuotas de todos los trasteros alquilables del local. */
  potentialMrr: number;
  byType: {
    unitTypeId: string | null;
    name: string;
    total: number;
    reserved: number;
    available: number;
    /** Precio más bajo de los libres de ese tipo (null si no queda ninguno). */
    fromPrice: number | null;
  }[];
}

export interface PreOpeningAnalyticsDto {
  facilities: PreOpeningFacilityDto[];
}

export interface OccupancyHistoryDto {
  points: OccupancyHistoryPointDto[];
  /** El mismo mes del año pasado (null si aún no había trasteros). */
  yearAgo: OccupancyHistoryPointDto | null;
  byFacility: OccupancyHistorySeriesDto[];
  byUnitType: OccupancyHistorySeriesDto[];
}

export type RevenueConcept = 'rent' | 'insurance' | 'late_fee' | 'shop' | 'night_pass' | 'other';

export interface RevenueBreakdownRowDto {
  key: string;
  label: string;
  /** Base imponible (sin IVA). */
  amount: number;
}

export interface RevenueBreakdownDto {
  from: string;
  to: string;
  total: number;
  byConcept: (RevenueBreakdownRowDto & { key: RevenueConcept })[];
  byFacility: RevenueBreakdownRowDto[];
  /** Solo el alquiler, por tipo de trastero. */
  byUnitType: RevenueBreakdownRowDto[];
}

export interface CohortRowDto {
  /** Mes en que empezaron los contratos (YYYY-MM). */
  yearMonth: string;
  contracts: number;
  /** % que seguía a los 3, 6 y 12 meses (null = aún no ha pasado ese tiempo). */
  retained3: number | null;
  retained6: number | null;
  retained12: number | null;
  /** Meses de media que han durado (los vivos, hasta hoy). */
  avgStayMonths: number;
  /** Facturado de media por contrato (con IVA); null sin permiso para ver el dinero. */
  revenuePerContract: number | null;
}

export interface CohortsDto {
  cohorts: CohortRowDto[];
}

/** Por qué se van: lo que responden en la encuesta de salida. */
export interface ExitReasonsDto {
  /** Encuestas de salida enviadas en el periodo. */
  sent: number;
  /** Las que se han respondido. */
  answered: number;
  /** NPS de quienes se van; null sin respuestas. */
  nps: number | null;
  reasons: ExitReasonRowDto[];
}

export interface ExitReasonRowDto {
  /** Clave del motivo, o `not_given` si no lo marcó. */
  reason: string;
  label: string;
  count: number;
  /** Sobre las respondidas (0-100). */
  pct: number;
}

// ---------------------------------------------------------------------------
// Mejoras de Analítica (2026-11-19)
// ---------------------------------------------------------------------------

/** Una línea con cómo va el mes en curso frente al anterior hasta el mismo día. */
export interface AnalyticsHeadlineDto {
  /** Mes en curso (AAAA-MM) y día de hoy en la hora del negocio. */
  yearMonth: string;
  day: number;
  /** Facturado (con IVA) este mes y el mes pasado hasta el mismo día; null sin permiso. */
  invoiced: number | null;
  invoicedPrev: number | null;
  /** Ocupación de hoy y al cerrar el mes pasado (0-1). */
  occupancy: number;
  occupancyPrev: number | null;
  moveIns: number;
  moveOuts: number;
  /** Contactos recibidos este mes y el mes pasado hasta el mismo día. */
  leads: number;
  leadsPrev: number;
  /** Vencido sin cobrar hoy; null sin permiso. */
  overdue: number | null;
}

/** De quién y de qué local es la deuda vencida, y cuánto se tarda en cobrar. */
export interface ArrearsBreakdownDto {
  byCustomer: {
    customerId: string;
    customerName: string;
    amount: number;
    invoices: number;
    /** Días desde el vencimiento de su factura más antigua sin cobrar. */
    oldestDays: number;
  }[];
  /** Inquilinos con deuda vencida (la lista enseña los 10 que más deben). */
  customerCount: number;
  byFacility: {
    facilityId: string | null;
    facilityName: string;
    amount: number;
    invoices: number;
  }[];
  /** Media de días desde la emisión hasta el cobro de las facturas cobradas en 90 días. */
  avgDaysToCollect: number | null;
  /** Media de días de retraso sobre el vencimiento de esas mismas facturas. */
  avgDaysLate: number | null;
  collectedInvoices: number;
}

/** Contratos que pagan menos que el precio de hoy de su trastero. */
export interface PortfolioGapRowDto {
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  unitCode: string;
  facilityName: string;
  /** Cuota del contrato (sin IVA, antes de descuentos puntuales). */
  paying: number;
  /** Precio de hoy del trastero. */
  listPrice: number;
  gap: number;
  gapPct: number;
  /** Fecha de la firma o del último cambio de cuota (AAAA-MM-DD). */
  since: string;
  monthsSince: number;
}

export interface PortfolioGapDto {
  rows: PortfolioGapRowDto[];
  /** Lo que se ingresaría al mes si todos pagaran el precio de hoy. */
  totalGapMonthly: number;
  liveContracts: number;
}

export type ForecastScenarioKey = 'low' | 'expected' | 'high';

export interface ForecastScenarioDto {
  key: ForecastScenarioKey;
  churnRate: number;
  adds: number;
  points: {
    yearMonth: string;
    contracts: number;
    occupancy: number;
    mrr: number | null;
  }[];
  /** Mes (AAAA-MM) en que se llenaría, en los próximos 5 años; null si no. */
  fullBy: string | null;
}

export interface ForecastSegmentDto {
  kind: 'facility' | 'unitType';
  id: string;
  name: string;
  capacity: number;
  occupied: number;
  /** Altas menos bajas al mes (media de los meses cerrados). */
  netPerMonth: number;
  fullBy: string | null;
}

export interface ForecastScenariosDto {
  scenarios: ForecastScenarioDto[];
  segments: ForecastSegmentDto[];
  /** Meses cerrados en los que se basan las medias. */
  historyMonths: number;
}

/** Rendimiento de cada tipo de trastero: por m² y frente al precio de catálogo. */
export interface UnitEconomicsRowDto {
  unitTypeId: string;
  name: string;
  units: number;
  occupied: number;
  areaM2: number;
  occupiedAreaM2: number;
  /** Cuotas al mes de los contratos en vigor (sin IVA). */
  revenueMonthly: number;
  /** Cuotas al mes entre los m² alquilados y entre todos los m². */
  revenuePerRentedM2: number | null;
  revenuePerM2: number | null;
  /** Cuota media de los contratos y precio medio de hoy de esos trasteros. */
  avgFee: number | null;
  avgListPrice: number | null;
  /** Cuánto pagan de media por encima (+) o por debajo (−) del precio de hoy, en %. */
  feeVsListPct: number | null;
}

export interface UnitEconomicsDto {
  rows: UnitEconomicsRowDto[];
  totals: Omit<UnitEconomicsRowDto, 'unitTypeId' | 'name'>;
}

export type TenureBucket = 'lt3' | '3to6' | '6to12' | '12to24' | 'gt24';

/** Cuotas que entran y salen cada mes, y cuánto llevaban los que se van. */
export interface ChurnBreakdownDto {
  months: {
    yearMonth: string;
    /** Cuotas al mes de las altas y de las bajas del mes; null sin permiso. */
    mrrGained: number | null;
    mrrLost: number | null;
  }[];
  tenure: { bucket: TenureBucket; ended: number }[];
  ended: number;
}

export interface ApplyUnitPricingManyResultDto {
  applied: number;
  failed: { unitId: string; message: string }[];
}

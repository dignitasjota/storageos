import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AgingKpiDto,
  ApplyPricingResultDto,
  BenchmarkDto,
  ChurnKpiDto,
  ChurnRiskKpiDto,
  CustomerStatsKpiDto,
  LeadsFunnelKpiDto,
  LeadsUtmKpiDto,
  MonthlyRevenueKpiDto,
  OccupancyKpiDto,
  PriceChangeEffectsDto,
  PricingStrategyDto,
  PricingSuggestionsDto,
  UnitPricingSuggestionsDto,
  UpdatePricingStrategyInput,
  ApplyUnitPricingResultDto,
  RevenueForecastDto,
  RevenueKpiDto,
  SeoChecklistDto,
  SuggestedActionsDto,
  CohortsDto,
  ExitReasonsDto,
  CompetitionAlertsDto,
  OccupancyHistoryDto,
  PreOpeningAnalyticsDto,
  RevenueBreakdownDto,
  AnalyticsHeadlineDto,
  ArrearsBreakdownDto,
  ApplyUnitPricingManyResultDto,
  ChurnBreakdownDto,
  ForecastScenariosDto,
  PortfolioGapDto,
  UnitEconomicsDto,
} from '@storageos/shared';

export const analyticsKey = (
  scope:
    | 'occupancy'
    | 'churn'
    | 'aging'
    | 'leads-funnel'
    | 'customers'
    | 'revenue'
    | 'monthly-revenue'
    | 'leads-utm'
    | 'churn-risk'
    | 'pricing-suggestions'
    | 'unit-pricing-suggestions'
    | 'pricing-strategy'
    | 'price-change-effects'
    | 'suggested-actions'
    | 'forecast'
    | 'benchmark'
    | 'seo-checklist'
    | 'occupancy-history'
    | 'pre-opening'
    | 'revenue-breakdown'
    | 'cohorts'
    | 'exit-reasons'
    | 'competition-alerts'
    | 'headline'
    | 'arrears-breakdown'
    | 'portfolio-gap'
    | 'unit-economics'
    | 'churn-breakdown'
    | 'forecast-scenarios',
  params?: Record<string, string | undefined>,
) => ['analytics', scope, params ?? {}] as const;

/** Query string con los parámetros que tienen valor. */
function query(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const str = qs.toString();
  return str ? `?${str}` : '';
}

/** Una línea con cómo va el mes en curso. */
export function useAnalyticsHeadline(params: { facilityId?: string; ownerId?: string }) {
  return useQuery({
    queryKey: analyticsKey('headline', params),
    queryFn: () => apiFetch<AnalyticsHeadlineDto>(`/analytics/headline${query(params)}`),
  });
}

/** Deuda vencida por inquilino y por local, y días que se tarda en cobrar. */
export function useArrearsBreakdown(params: { facilityId?: string; ownerId?: string }) {
  return useQuery({
    queryKey: analyticsKey('arrears-breakdown', params),
    queryFn: () => apiFetch<ArrearsBreakdownDto>(`/analytics/arrears-breakdown${query(params)}`),
  });
}

/** Contratos que pagan menos que el precio de hoy de su trastero. */
export function usePortfolioGap(facilityId?: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: analyticsKey('portfolio-gap', { facilityId }),
    queryFn: () => apiFetch<PortfolioGapDto>(`/analytics/portfolio-gap${query({ facilityId })}`),
  });
}

/** Cuotas por m² de cada tipo de trastero y frente a su precio de hoy. */
export function useUnitEconomics(facilityId?: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: analyticsKey('unit-economics', { facilityId }),
    queryFn: () => apiFetch<UnitEconomicsDto>(`/analytics/unit-economics${query({ facilityId })}`),
  });
}

/** Cuotas que entran y salen cada mes y antigüedad de las bajas. */
export function useChurnBreakdown(params: Range = {}) {
  return useQuery({
    queryKey: analyticsKey('churn-breakdown', params),
    queryFn: () => apiFetch<ChurnBreakdownDto>(`/analytics/churn-breakdown${query(params)}`),
  });
}

/** Escenarios de la previsión y cuándo se llenaría cada local y tipo. */
export function useForecastScenarios(facilityId?: string) {
  return useQuery({
    queryKey: analyticsKey('forecast-scenarios', { facilityId }),
    queryFn: () =>
      apiFetch<ForecastScenariosDto>(`/analytics/forecast-scenarios${query({ facilityId })}`),
  });
}

/** Aplica de una vez el precio sugerido de varios trasteros. */
export function useApplyUnitPricingMany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: { unitId: string; price: number }[]) =>
      apiFetch<ApplyUnitPricingManyResultDto>('/analytics/unit-pricing-suggestions/apply-many', {
        method: 'POST',
        json: { items },
      }),
    onSuccess: () => invalidatePrices(qc),
  });
}

export function useBenchmark() {
  return useQuery({
    queryKey: analyticsKey('benchmark'),
    queryFn: () => apiFetch<BenchmarkDto>('/analytics/benchmark'),
  });
}

export function useMonthlyRevenue(
  arg:
    | number
    | { months?: number; from?: string; to?: string; facilityId?: string; ownerId?: string } = 12,
  enabled = true,
) {
  const params = typeof arg === 'number' ? { months: arg } : arg;
  const ranged = !!(params.from && params.to);
  const p = {
    from: ranged ? params.from : undefined,
    to: ranged ? params.to : undefined,
    months: !ranged && params.months ? String(params.months) : undefined,
    facilityId: 'facilityId' in params ? params.facilityId : undefined,
    ownerId: 'ownerId' in params ? params.ownerId : undefined,
  };
  return useQuery({
    enabled,
    queryKey: analyticsKey('monthly-revenue', p),
    queryFn: () => apiFetch<MonthlyRevenueKpiDto>(`/analytics/monthly-revenue${query(p)}`),
  });
}

export function useCustomerStats(facilityId?: string) {
  return useQuery({
    queryKey: analyticsKey('customers', { facilityId }),
    queryFn: () => apiFetch<CustomerStatsKpiDto>(`/analytics/customers${query({ facilityId })}`),
  });
}

export function useRevenueKpis(facilityId?: string) {
  return useQuery({
    queryKey: analyticsKey('revenue', { facilityId }),
    queryFn: () => apiFetch<RevenueKpiDto>(`/analytics/revenue${query({ facilityId })}`),
  });
}

export function useOccupancy(params: { facilityId?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.facilityId) qs.set('facilityId', params.facilityId);
  return useQuery({
    queryKey: analyticsKey('occupancy', params as Record<string, string | undefined>),
    queryFn: () =>
      apiFetch<OccupancyKpiDto>(`/analytics/occupancy${qs.toString() ? `?${qs}` : ''}`),
  });
}

type Range = { from?: string; to?: string; facilityId?: string };

export function useChurn(params: Range = {}) {
  return useQuery({
    queryKey: analyticsKey('churn', params),
    queryFn: () => apiFetch<ChurnKpiDto>(`/analytics/churn${query(params)}`),
  });
}

export function useAging(params: { atDate?: string; facilityId?: string; ownerId?: string } = {}) {
  return useQuery({
    queryKey: analyticsKey('aging', params),
    queryFn: () => apiFetch<AgingKpiDto>(`/analytics/aging${query(params)}`),
  });
}

export function useLeadsFunnel(params: Range = {}) {
  return useQuery({
    queryKey: analyticsKey('leads-funnel', params),
    queryFn: () => apiFetch<LeadsFunnelKpiDto>(`/analytics/leads-funnel${query(params)}`),
  });
}

export function useLeadsUtm(params: Range = {}) {
  return useQuery({
    queryKey: analyticsKey('leads-utm', params),
    queryFn: () => apiFetch<LeadsUtmKpiDto>(`/analytics/leads-utm${query(params)}`),
  });
}

export function useSeoChecklist() {
  return useQuery({
    queryKey: analyticsKey('seo-checklist'),
    queryFn: () => apiFetch<SeoChecklistDto>('/analytics/seo-checklist'),
    staleTime: 60_000,
  });
}

export function useChurnRisk(facilityId?: string) {
  return useQuery({
    queryKey: analyticsKey('churn-risk', { facilityId }),
    queryFn: () => apiFetch<ChurnRiskKpiDto>(`/analytics/churn-risk${query({ facilityId })}`),
  });
}

export function usePricingSuggestions(facilityId?: string) {
  return useQuery({
    queryKey: analyticsKey('pricing-suggestions', { facilityId }),
    queryFn: () =>
      apiFetch<PricingSuggestionsDto>(`/analytics/pricing-suggestions${query({ facilityId })}`),
  });
}

export function useSuggestedActions(facilityId?: string) {
  const qs = facilityId ? `?facilityId=${facilityId}` : '';
  return useQuery({
    queryKey: analyticsKey('suggested-actions', { facilityId }),
    queryFn: () => apiFetch<SuggestedActionsDto>(`/analytics/suggested-actions${qs}`),
    staleTime: 60_000,
  });
}

/** Lo que cambia al aplicar un precio: sugerencias, efectos, ocupación y trasteros. */
function invalidatePrices(qc: ReturnType<typeof useQueryClient>) {
  for (const scope of [
    'pricing-suggestions',
    'unit-pricing-suggestions',
    'price-change-effects',
    'occupancy',
    'suggested-actions',
    'portfolio-gap',
    'unit-economics',
  ] as const) {
    void qc.invalidateQueries({ queryKey: analyticsKey(scope) });
  }
  void qc.invalidateQueries({ queryKey: ['unit-types'] });
  void qc.invalidateQueries({ queryKey: ['units'] });
}

export function useApplyPricing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { unitTypeId: string; price: number }) =>
      apiFetch<ApplyPricingResultDto>('/analytics/pricing-suggestions/apply', {
        method: 'POST',
        json: args,
      }),
    onSuccess: () => invalidatePrices(qc),
  });
}

/** Sugerencia de precio por trastero (mercado + posicionamiento + demanda). */
export function useUnitPricingSuggestions(
  facilityId?: string,
  includeCompetition = true,
  enabled = true,
) {
  const params = new URLSearchParams();
  if (facilityId) params.set('facilityId', facilityId);
  if (!includeCompetition) params.set('includeCompetition', 'false');
  const qs = params.toString() ? `?${params}` : '';
  return useQuery({
    enabled,
    queryKey: analyticsKey('unit-pricing-suggestions', {
      facilityId,
      includeCompetition: includeCompetition ? undefined : 'false',
    }),
    queryFn: () => apiFetch<UnitPricingSuggestionsDto>(`/analytics/unit-pricing-suggestions${qs}`),
  });
}

export function useApplyUnitPricing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { unitId: string; price: number }) =>
      apiFetch<ApplyUnitPricingResultDto>('/analytics/unit-pricing-suggestions/apply', {
        method: 'POST',
        json: args,
      }),
    onSuccess: () => invalidatePrices(qc),
  });
}

/** Estrategia de precios: ocupación objetivo, límites y posicionamiento por local. */
export function usePricingStrategy(enabled = true) {
  return useQuery({
    enabled,
    queryKey: analyticsKey('pricing-strategy'),
    queryFn: () => apiFetch<PricingStrategyDto>('/analytics/pricing-strategy'),
  });
}

export function useUpdatePricingStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePricingStrategyInput) =>
      apiFetch<PricingStrategyDto>('/analytics/pricing-strategy', { method: 'PUT', json: input }),
    onSuccess: (data) => {
      qc.setQueryData(analyticsKey('pricing-strategy'), data);
      void qc.invalidateQueries({ queryKey: analyticsKey('unit-pricing-suggestions') });
      void qc.invalidateQueries({ queryKey: analyticsKey('pricing-suggestions') });
    },
  });
}

export function useRevenueForecast(params: { months?: number; facilityId?: string } = {}) {
  const p = {
    months: params.months ? String(params.months) : undefined,
    facilityId: params.facilityId,
  };
  return useQuery({
    queryKey: analyticsKey('forecast', p),
    queryFn: () => apiFetch<RevenueForecastDto>(`/analytics/forecast${query(p)}`),
  });
}

/** Efecto de tus cambios de precio en la demanda (informativo). */
export function usePriceChangeEffects(facilityId?: string) {
  return useQuery({
    queryKey: analyticsKey('price-change-effects', { facilityId }),
    queryFn: () =>
      apiFetch<PriceChangeEffectsDto>(`/analytics/price-change-effects${query({ facilityId })}`),
  });
}

// --- Tendencias -------------------------------------------------------------

/** Preventa de los locales por abrir. */
export function usePreOpeningAnalytics(params: { facilityId?: string } = {}) {
  return useQuery({
    queryKey: analyticsKey('pre-opening', params),
    queryFn: () => apiFetch<PreOpeningAnalyticsDto>(`/analytics/pre-opening${query(params)}`),
  });
}

export function useOccupancyHistory(params: { months?: number; facilityId?: string } = {}) {
  const p = {
    months: params.months ? String(params.months) : undefined,
    facilityId: params.facilityId,
  };
  return useQuery({
    queryKey: analyticsKey('occupancy-history', p),
    queryFn: () => apiFetch<OccupancyHistoryDto>(`/analytics/occupancy-history${query(p)}`),
  });
}

export function useRevenueBreakdown(params: Range & { ownerId?: string } = {}) {
  return useQuery({
    queryKey: analyticsKey('revenue-breakdown', params),
    queryFn: () => apiFetch<RevenueBreakdownDto>(`/analytics/revenue-breakdown${query(params)}`),
  });
}

export function useCohorts(
  params: { months?: number; facilityId?: string; ownerId?: string } = {},
) {
  const p = {
    months: params.months ? String(params.months) : undefined,
    facilityId: params.facilityId,
    ownerId: params.ownerId,
  };
  return useQuery({
    queryKey: analyticsKey('cohorts', p),
    queryFn: () => apiFetch<CohortsDto>(`/analytics/cohorts${query(p)}`),
  });
}

/** Motivos de baja de la encuesta de salida. */
export function useExitReasons(params: Range = {}) {
  const p = { from: params.from, to: params.to, facilityId: params.facilityId };
  return useQuery({
    queryKey: analyticsKey('exit-reasons', p),
    queryFn: () => apiFetch<ExitReasonsDto>(`/analytics/exit-reasons${query(p)}`),
  });
}

export function useCompetitionAlerts(facilityId?: string) {
  return useQuery({
    queryKey: analyticsKey('competition-alerts', { facilityId }),
    queryFn: () =>
      apiFetch<CompetitionAlertsDto>(`/analytics/competition-alerts${query({ facilityId })}`),
  });
}

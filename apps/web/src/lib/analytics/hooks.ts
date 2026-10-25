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
  CompetitionAlertsDto,
  OccupancyHistoryDto,
  RevenueBreakdownDto,
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
    | 'revenue-breakdown'
    | 'cohorts'
    | 'competition-alerts',
  params?: Record<string, string | undefined>,
) => ['analytics', scope, params ?? {}] as const;

/** Query string con los parámetros que tienen valor. */
function query(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const str = qs.toString();
  return str ? `?${str}` : '';
}

export function useBenchmark() {
  return useQuery({
    queryKey: analyticsKey('benchmark'),
    queryFn: () => apiFetch<BenchmarkDto>('/analytics/benchmark'),
  });
}

export function useMonthlyRevenue(
  arg: number | { months?: number; from?: string; to?: string; facilityId?: string } = 12,
) {
  const params = typeof arg === 'number' ? { months: arg } : arg;
  const ranged = !!(params.from && params.to);
  const p = {
    from: ranged ? params.from : undefined,
    to: ranged ? params.to : undefined,
    months: !ranged && params.months ? String(params.months) : undefined,
    facilityId: 'facilityId' in params ? params.facilityId : undefined,
  };
  return useQuery({
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

export function useAging(params: { atDate?: string; facilityId?: string } = {}) {
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

export function useSuggestedActions() {
  return useQuery({
    queryKey: analyticsKey('suggested-actions'),
    queryFn: () => apiFetch<SuggestedActionsDto>('/analytics/suggested-actions'),
    staleTime: 60_000,
  });
}

export function useApplyPricing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { unitTypeId: string; price: number }) =>
      apiFetch<ApplyPricingResultDto>('/analytics/pricing-suggestions/apply', {
        method: 'POST',
        json: args,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: analyticsKey('pricing-suggestions') });
      void qc.invalidateQueries({ queryKey: ['unit-types'] });
    },
  });
}

/** Sugerencia de precio por trastero (mercado + posicionamiento + demanda). */
export function useUnitPricingSuggestions(facilityId?: string, includeCompetition = true) {
  const params = new URLSearchParams();
  if (facilityId) params.set('facilityId', facilityId);
  if (!includeCompetition) params.set('includeCompetition', 'false');
  const qs = params.toString() ? `?${params}` : '';
  return useQuery({
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: analyticsKey('unit-pricing-suggestions') });
      void qc.invalidateQueries({ queryKey: ['units'] });
    },
  });
}

/** Estrategia de precios: ocupación objetivo, límites y posicionamiento por local. */
export function usePricingStrategy() {
  return useQuery({
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

export function useRevenueBreakdown(params: Range = {}) {
  return useQuery({
    queryKey: analyticsKey('revenue-breakdown', params),
    queryFn: () => apiFetch<RevenueBreakdownDto>(`/analytics/revenue-breakdown${query(params)}`),
  });
}

export function useCohorts(params: { months?: number; facilityId?: string } = {}) {
  const p = {
    months: params.months ? String(params.months) : undefined,
    facilityId: params.facilityId,
  };
  return useQuery({
    queryKey: analyticsKey('cohorts', p),
    queryFn: () => apiFetch<CohortsDto>(`/analytics/cohorts${query(p)}`),
  });
}

export function useCompetitionAlerts(facilityId?: string) {
  return useQuery({
    queryKey: analyticsKey('competition-alerts', { facilityId }),
    queryFn: () =>
      apiFetch<CompetitionAlertsDto>(`/analytics/competition-alerts${query({ facilityId })}`),
  });
}

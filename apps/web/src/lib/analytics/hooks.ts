import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AgingKpiDto,
  ChurnKpiDto,
  ChurnRiskKpiDto,
  CustomerStatsKpiDto,
  LeadsFunnelKpiDto,
  OccupancyKpiDto,
  PricingSuggestionsDto,
  RevenueForecastDto,
  RevenueKpiDto,
} from '@storageos/shared';

export const analyticsKey = (
  scope:
    | 'occupancy'
    | 'churn'
    | 'aging'
    | 'leads-funnel'
    | 'customers'
    | 'revenue'
    | 'churn-risk'
    | 'pricing-suggestions'
    | 'forecast',
  params?: Record<string, string | undefined>,
) => ['analytics', scope, params ?? {}] as const;

export function useCustomerStats() {
  return useQuery({
    queryKey: analyticsKey('customers'),
    queryFn: () => apiFetch<CustomerStatsKpiDto>('/analytics/customers'),
  });
}

export function useRevenueKpis() {
  return useQuery({
    queryKey: analyticsKey('revenue'),
    queryFn: () => apiFetch<RevenueKpiDto>('/analytics/revenue'),
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

export function useChurn(params: { from?: string; to?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  return useQuery({
    queryKey: analyticsKey('churn', params as Record<string, string | undefined>),
    queryFn: () => apiFetch<ChurnKpiDto>(`/analytics/churn${qs.toString() ? `?${qs}` : ''}`),
  });
}

export function useAging(params: { atDate?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.atDate) qs.set('atDate', params.atDate);
  return useQuery({
    queryKey: analyticsKey('aging', params as Record<string, string | undefined>),
    queryFn: () => apiFetch<AgingKpiDto>(`/analytics/aging${qs.toString() ? `?${qs}` : ''}`),
  });
}

export function useLeadsFunnel(params: { from?: string; to?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  return useQuery({
    queryKey: analyticsKey('leads-funnel', params as Record<string, string | undefined>),
    queryFn: () =>
      apiFetch<LeadsFunnelKpiDto>(`/analytics/leads-funnel${qs.toString() ? `?${qs}` : ''}`),
  });
}

export function useChurnRisk() {
  return useQuery({
    queryKey: analyticsKey('churn-risk'),
    queryFn: () => apiFetch<ChurnRiskKpiDto>('/analytics/churn-risk'),
  });
}

export function usePricingSuggestions() {
  return useQuery({
    queryKey: analyticsKey('pricing-suggestions'),
    queryFn: () => apiFetch<PricingSuggestionsDto>('/analytics/pricing-suggestions'),
  });
}

export function useRevenueForecast(params: { months?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.months) qs.set('months', String(params.months));
  return useQuery({
    queryKey: analyticsKey('forecast', {
      months: params.months ? String(params.months) : undefined,
    }),
    queryFn: () =>
      apiFetch<RevenueForecastDto>(`/analytics/forecast${qs.toString() ? `?${qs}` : ''}`),
  });
}

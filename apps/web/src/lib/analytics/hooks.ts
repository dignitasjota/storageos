import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AgingKpiDto,
  ChurnKpiDto,
  LeadsFunnelKpiDto,
  OccupancyKpiDto,
} from '@storageos/shared';

export const analyticsKey = (
  scope: 'occupancy' | 'churn' | 'aging' | 'leads-funnel',
  params?: Record<string, string | undefined>,
) => ['analytics', scope, params ?? {}] as const;

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

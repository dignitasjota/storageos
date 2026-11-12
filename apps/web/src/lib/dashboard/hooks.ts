import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateTenantTodaySnoozeInput,
  DailySummaryPrefs,
  DashboardLayout,
  DashboardOverviewDto,
  DashboardPeriod,
  TenantTodaySnoozeDto,
  TodayDto,
  TodayExtrasDto,
  TodaySummaryDto,
} from '@storageos/shared';

/** Bandeja operativa «Hoy»: lo que el equipo debe atender (sondea cada 60 s). */
export function useToday(facilityId?: string, mine = false, full = false) {
  const p = new URLSearchParams();
  if (facilityId) p.set('facilityId', facilityId);
  if (mine) p.set('mine', '1');
  if (full) p.set('full', '1');
  const qs = p.toString() ? `?${p.toString()}` : '';
  return useQuery({
    queryKey: ['dashboard', 'today', facilityId ?? null, mine, full] as const,
    queryFn: () => apiFetch<TodayDto>(`/dashboard/today${qs}`),
    // Cada 5 minutos y al volver a la pestaña (no cada minuto todo el día).
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });
}

/** Cifras del mes y actividad de las últimas 48 h (cabecera de «Hoy»). */
export function useTodaySummary(facilityId?: string, enabled = true) {
  const qs = facilityId ? `?facilityId=${facilityId}` : '';
  return useQuery({
    enabled,
    queryKey: ['dashboard', 'today', 'summary', facilityId ?? null] as const,
    queryFn: () => apiFetch<TodaySummaryDto>(`/dashboard/today/summary${qs}`),
    // Cada 5 minutos y al volver a la pestaña (no cada minuto todo el día).
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });
}

/** Todas las cifras del Resumen en una sola petición. */
export function useDashboardOverview(facilityId: string | undefined, period: DashboardPeriod) {
  const p = new URLSearchParams({ period });
  if (facilityId) p.set('facilityId', facilityId);
  return useQuery({
    queryKey: ['dashboard', 'overview', facilityId ?? null, period] as const,
    queryFn: () => apiFetch<DashboardOverviewDto>(`/dashboard/overview?${p.toString()}`),
    placeholderData: keepPreviousData,
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });
}

/** Tarjetas del Resumen que ve el usuario, y su orden. */
export function useDashboardLayout() {
  return useQuery({
    queryKey: ['dashboard', 'layout'] as const,
    queryFn: () => apiFetch<DashboardLayout>('/dashboard/me/layout'),
    staleTime: Infinity,
  });
}

export function useSaveDashboardLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (layout: DashboardLayout) =>
      apiFetch<DashboardLayout>('/dashboard/me/layout', { method: 'PUT', json: layout }),
    onSuccess: (layout) => qc.setQueryData(['dashboard', 'layout'], layout),
  });
}

/** Lo que completa «Hoy»: avisos, deuda por inquilino, mañana, la semana y lo hecho. */
export function useTodayExtras(facilityId?: string, mine = false) {
  const p = new URLSearchParams();
  if (facilityId) p.set('facilityId', facilityId);
  if (mine) p.set('mine', '1');
  const qs = p.toString();
  return useQuery({
    queryKey: ['dashboard', 'today', 'extras', facilityId ?? null, mine] as const,
    queryFn: () => apiFetch<TodayExtrasDto>(`/dashboard/today/extras${qs ? `?${qs}` : ''}`),
    refetchInterval: 5 * 60_000,
  });
}

export function useSnoozeToday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantTodaySnoozeInput) =>
      apiFetch<TenantTodaySnoozeDto>('/dashboard/today/snoozes', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dashboard', 'today'] });
      // Apartar a un deudor también cambia Deudores.
      void qc.invalidateQueries({ queryKey: ['arrears'] });
    },
  });
}

export function useUnsnoozeToday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/dashboard/today/snoozes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dashboard', 'today'] });
      void qc.invalidateQueries({ queryKey: ['arrears'] });
    },
  });
}

export function useDailySummaryPrefs() {
  return useQuery({
    queryKey: ['dashboard', 'daily-summary-prefs'] as const,
    queryFn: () => apiFetch<DailySummaryPrefs>('/dashboard/me/daily-summary'),
  });
}

export function useSaveDailySummaryPrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prefs: DailySummaryPrefs) =>
      apiFetch<DailySummaryPrefs>('/dashboard/me/daily-summary', { method: 'PUT', json: prefs }),
    onSuccess: (data) => qc.setQueryData(['dashboard', 'daily-summary-prefs'], data),
  });
}

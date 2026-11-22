import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch, adminApiFetchBlob } from './api';
import { LIVE_METRICS } from './live-metrics';

import type {
  AdminAcquisitionDto,
  AdminBreakdownDto,
  AdminCashMonthDto,
  AdminClientStatesDto,
  AdminConcentrationDto,
  AdminFinanceCsvKind,
  AdminFinanceSettingsDto,
  AdminMarginDto,
  AdminMetricAnnotationDto,
  AdminRevenueSeriesBy,
  AdminRevenueSeriesDto,
  AdminVatQuarterlyDto,
  CreateMetricAnnotationInput,
  UpdateFinanceSettingsInput,
  UpdateMarketingSpendInput,
  UpdateMetricAnnotationInput,
} from '@storageos/shared';

/** Lo nuevo de Métricas y Finanzas del panel super admin. */

export function useClientStates(months = 12) {
  return useQuery({
    queryKey: ['admin', 'metrics', 'states', months] as const,
    queryFn: () => adminApiFetch<AdminClientStatesDto>(`/admin/metrics/states?months=${months}`),
    ...LIVE_METRICS,
  });
}

export function useConcentration() {
  return useQuery({
    queryKey: ['admin', 'metrics', 'concentration'] as const,
    queryFn: () => adminApiFetch<AdminConcentrationDto>('/admin/metrics/concentration'),
    ...LIVE_METRICS,
  });
}

export function useRevenueSeries(by: AdminRevenueSeriesBy, months = 12) {
  return useQuery({
    queryKey: ['admin', 'metrics', 'revenue-series', by, months] as const,
    queryFn: () =>
      adminApiFetch<AdminRevenueSeriesDto>(
        `/admin/metrics/revenue-series?by=${by}&months=${months}`,
      ),
    ...LIVE_METRICS,
  });
}

/** Qué tenants forman una cifra (`metric` y, según la cifra, `month`, `plan` o `kind`). */
export interface BreakdownParams {
  metric: string;
  month?: string;
  plan?: string;
  kind?: string;
}

export function useMetricBreakdown(params: BreakdownParams | null) {
  const qs = params
    ? new URLSearchParams(
        Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string'),
      ).toString()
    : '';
  return useQuery({
    queryKey: ['admin', 'metrics', 'breakdown', qs] as const,
    queryFn: () => adminApiFetch<AdminBreakdownDto>(`/admin/metrics/breakdown?${qs}`),
    enabled: !!params,
    staleTime: 30_000,
  });
}

// --- Anotaciones --------------------------------------------------------------

const ANNOTATIONS_KEY = ['admin', 'metrics', 'annotations'] as const;

export function useMetricAnnotations() {
  return useQuery({
    queryKey: ANNOTATIONS_KEY,
    queryFn: () => adminApiFetch<AdminMetricAnnotationDto[]>('/admin/metrics/annotations'),
    staleTime: 60_000,
  });
}

export function useCreateAnnotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMetricAnnotationInput) =>
      adminApiFetch<AdminMetricAnnotationDto>('/admin/metrics/annotations', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ANNOTATIONS_KEY }),
  });
}

export function useUpdateAnnotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateMetricAnnotationInput & { id: string }) =>
      adminApiFetch<AdminMetricAnnotationDto>(`/admin/metrics/annotations/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ANNOTATIONS_KEY }),
  });
}

export function useDeleteAnnotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/metrics/annotations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ANNOTATIONS_KEY }),
  });
}

// --- Finanzas -----------------------------------------------------------------

export function useFinanceMargin(months = 12) {
  return useQuery({
    queryKey: ['admin', 'finance', 'margin', months] as const,
    queryFn: () => adminApiFetch<AdminMarginDto>(`/admin/finance/margin?months=${months}`),
    ...LIVE_METRICS,
  });
}

export function useFinanceAcquisition(months = 12) {
  return useQuery({
    queryKey: ['admin', 'finance', 'acquisition', months] as const,
    queryFn: () =>
      adminApiFetch<AdminAcquisitionDto>(`/admin/finance/acquisition?months=${months}`),
    ...LIVE_METRICS,
  });
}

export function useCashMonth() {
  return useQuery({
    queryKey: ['admin', 'finance', 'cash-month'] as const,
    queryFn: () => adminApiFetch<AdminCashMonthDto>('/admin/finance/cash-month'),
    ...LIVE_METRICS,
  });
}

export function useVatQuarterly(year: number) {
  return useQuery({
    queryKey: ['admin', 'finance', 'vat-quarterly', year] as const,
    queryFn: () => adminApiFetch<AdminVatQuarterlyDto>(`/admin/finance/vat-quarterly?year=${year}`),
    staleTime: 60_000,
  });
}

export function useFinanceSettings() {
  return useQuery({
    queryKey: ['admin', 'finance', 'settings'] as const,
    queryFn: () => adminApiFetch<AdminFinanceSettingsDto>('/admin/finance/settings'),
  });
}

export function useUpdateFinanceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateFinanceSettingsInput) =>
      adminApiFetch<AdminFinanceSettingsDto>('/admin/finance/settings', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'finance', 'settings'], data);
      void qc.invalidateQueries({ queryKey: ['admin', 'finance', 'margin'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'finance', 'acquisition'] });
    },
  });
}

export interface MarketingSpendRow {
  month: string;
  amount: number;
  note: string | null;
}

export function useMarketingSpend(months = 12) {
  return useQuery({
    queryKey: ['admin', 'finance', 'marketing-spend', months] as const,
    queryFn: () =>
      adminApiFetch<MarketingSpendRow[]>(`/admin/finance/marketing-spend?months=${months}`),
  });
}

export function useSetMarketingSpend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ month, ...input }: UpdateMarketingSpendInput & { month: string }) =>
      adminApiFetch<MarketingSpendRow>(`/admin/finance/marketing-spend/${month}`, {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'finance', 'marketing-spend'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'finance', 'acquisition'] });
    },
  });
}

async function saveBlob(path: string, filename: string): Promise<void> {
  const blob = await adminApiFetchBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Descarga un CSV de Finanzas (lo genera el API). */
export function downloadFinanceCsv(
  kind: AdminFinanceCsvKind,
  opts: { months: number; vat: 'with' | 'without'; year?: number },
): Promise<void> {
  const qs = `kind=${kind}&months=${opts.months}&vat=${opts.vat}${opts.year ? `&year=${opts.year}` : ''}`;
  return saveBlob(`/admin/finance/export.csv?${qs}`, `finanzas-${kind}.csv`);
}

/** Descarga el informe de Finanzas en PDF. */
export function downloadFinancePdf(months: number, vat: 'with' | 'without'): Promise<void> {
  return saveBlob(
    `/admin/finance/report.pdf?months=${months}&vat=${vat}`,
    `finanzas-${months}m.pdf`,
  );
}

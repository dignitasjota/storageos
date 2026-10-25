'use client';

import { LEAD_LOST_REASON_LABELS, type LeadLostReason } from '@storageos/shared';
import { CheckCircle2, CircleDashed, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import {
  CsvButton,
  Delta,
  type Period,
  PeriodSelector,
  periodDays,
  periodPresets,
  periodText,
  previousPeriod,
} from './period';
import { PriceChangeEffectsPanel } from './price-change-effects-panel';
import { PricingStrategyButton } from './pricing-strategy-dialog';
import { CohortsPanel, OccupancyHistoryCard, RevenueBreakdownCard } from './trends-panels';
import { CONFIDENCE, TrendNote, UnitPricingPanel } from './unit-pricing-panel';

import type {
  BenchmarkMetricDto,
  ChurnRiskLevel,
  PricingAction,
  SeoChecklistItemDto,
} from '@storageos/shared';

import { FeatureGate } from '@/components/auth/feature-gate';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useAging,
  useApplyPricing,
  useBenchmark,
  useChurn,
  useChurnRisk,
  useLeadsFunnel,
  useLeadsUtm,
  useMonthlyRevenue,
  useOccupancy,
  usePricingSuggestions,
  useRevenueForecast,
  useSeoChecklist,
} from '@/lib/analytics/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

const ANALYTICS_TABS = [
  'revenue',
  'occupancy',
  'churn',
  'cohorts',
  'aging',
  'leads',
  'churn-risk',
  'pricing',
  'forecast',
  'market',
  'seo',
] as const;
type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

export default function AnalyticsPage() {
  // Pestaña inicial desde `?tab=` (p. ej. el nudge de SEO del Resumen enlaza
  // directo a `/analytics?tab=seo`) — se lee de `window.location` en un
  // efecto, no con `useSearchParams` (evita el requisito de Suspense de Next
  // para un caso tan simple; mismo patrón ya usado en book-shared.tsx).
  const [tab, setTab] = useState<AnalyticsTab>('revenue');
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested && (ANALYTICS_TABS as readonly string[]).includes(requested)) {
      setTab(requested as AnalyticsTab);
    }
  }, []);

  function handleTabChange(value: string) {
    setTab(value as AnalyticsTab);
    window.history.replaceState(null, '', `/analytics?tab=${value}`);
  }

  // El local de la página empieza con el de la cabecera y lo sigue.
  const [facilityId, setFacilityId] = useFacilityFilterState();
  const facilities = useFacilities();
  const facilityList = facilities.data ?? [];
  // Periodo común de Ingresos, Bajas y Contactos.
  const [period, setPeriod] = useState<Period>(() => periodPresets()[0]!);
  const usesPeriod = tab === 'revenue' || tab === 'churn' || tab === 'leads';

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analítica</h1>
          <p className="text-sm text-muted-foreground">
            KPIs clave del negocio: ingresos, ocupación, bajas, morosidad, contactos, riesgo de baja
            y precios.
          </p>
        </div>
        {facilityList.length > 1 && (
          <Select
            value={facilityId ?? 'all'}
            onValueChange={(v) => setFacilityId(v === 'all' ? undefined : v)}
          >
            <SelectTrigger className="w-56" aria-label="Local">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los locales</SelectItem>
              {facilityList.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {usesPeriod && <PeriodSelector value={period} onChange={setPeriod} />}

      <Tabs value={tab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="revenue">Ingresos</TabsTrigger>
          <TabsTrigger value="occupancy">Ocupación</TabsTrigger>
          <TabsTrigger value="churn">Bajas</TabsTrigger>
          <TabsTrigger value="cohorts">Cohortes</TabsTrigger>
          <TabsTrigger value="aging">Morosidad</TabsTrigger>
          <TabsTrigger value="leads">Leads</TabsTrigger>
          <TabsTrigger value="churn-risk">Riesgo de baja</TabsTrigger>
          <TabsTrigger value="pricing">Precios</TabsTrigger>
          <TabsTrigger value="forecast">Previsión</TabsTrigger>
          <TabsTrigger value="market">Comparativa del sector</TabsTrigger>
          <TabsTrigger value="seo">SEO</TabsTrigger>
        </TabsList>
        <TabsContent value="revenue" className="mt-4">
          <MonthlyRevenuePanel facilityId={facilityId} period={period} />
        </TabsContent>
        <TabsContent value="occupancy" className="mt-4">
          <OccupancyPanel facilityId={facilityId} />
        </TabsContent>
        <TabsContent value="churn" className="mt-4">
          <ChurnPanel facilityId={facilityId} period={period} />
        </TabsContent>
        <TabsContent value="cohorts" className="mt-4">
          <CohortsPanel facilityId={facilityId} />
        </TabsContent>
        <TabsContent value="aging" className="mt-4">
          <AgingPanel facilityId={facilityId} />
        </TabsContent>
        <TabsContent value="leads" className="mt-4">
          <LeadsPanel facilityId={facilityId} period={period} />
        </TabsContent>
        <TabsContent value="churn-risk" className="mt-4">
          <ChurnRiskPanel facilityId={facilityId} />
        </TabsContent>
        <TabsContent value="pricing" className="mt-4">
          <Tabs defaultValue="by-type" className="w-full">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TabsList>
                <TabsTrigger value="by-type">Por tipo de trastero</TabsTrigger>
                <TabsTrigger value="by-unit">Por trastero individual</TabsTrigger>
                <TabsTrigger value="effects">Efecto de tus cambios</TabsTrigger>
              </TabsList>
              <PricingStrategyButton />
            </div>
            <TabsContent value="by-type" className="mt-4">
              <PricingSuggestionsPanel facilityId={facilityId} />
            </TabsContent>
            <TabsContent value="by-unit" className="mt-4">
              <UnitPricingPanel facilityId={facilityId} />
            </TabsContent>
            <TabsContent value="effects" className="mt-4">
              <PriceChangeEffectsPanel facilityId={facilityId} />
            </TabsContent>
          </Tabs>
        </TabsContent>
        <TabsContent value="forecast" className="mt-4">
          <ForecastPanel facilityId={facilityId} />
        </TabsContent>
        <TabsContent value="market" className="mt-4">
          <BenchmarkPanel />
        </TabsContent>
        <TabsContent value="seo" className="mt-4">
          <FeatureGate feature="local_seo">
            <SeoChecklistPanel />
          </FeatureGate>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================================
// Ocupación
// ============================================================================

function OccupancyPanel({ facilityId }: { facilityId?: string }) {
  const occupancy = useOccupancy({ facilityId });

  if (occupancy.isLoading || !occupancy.data) {
    return <PanelLoader />;
  }

  const d = occupancy.data;
  const chartData = d.perFacility.map((f) => ({
    name: f.facilityName,
    Ocupados: f.occupied,
    Reservados: f.reserved,
    Libres: f.available,
    'Fuera de servicio': f.outOfService,
  }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="Ocupación física" value={formatPercent(d.physicalOccupancy)}>
          {d.occupiedUnits} de {d.totalUnits} trasteros
        </KpiCard>
        <KpiCard title="Ocupación económica" value={formatPercent(d.economicOccupancy)}>
          Lo que ingresas frente a lo que ingresarías con todo alquilado
        </KpiCard>
        <KpiCard title="MRR actual" value={formatCurrency(d.mrrActual)}>
          Cuotas de los contratos vivos, menos sus descuentos
        </KpiCard>
        <KpiCard title="MRR potencial" value={formatCurrency(d.mrrPotential)}>
          Precio de cada trastero que se puede alquilar
          {d.outOfServiceUnits > 0 ? ` (sin los ${d.outOfServiceUnits} fuera de servicio)` : ''}
        </KpiCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ocupación por local</CardTitle>
          <CardDescription>
            Trasteros ocupados, reservados, libres y fuera de servicio (mantenimiento o bloqueados)
            de cada local.
          </CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay locales todavía.</p>
          ) : (
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 256 }}
            >
              <BarChart data={chartData} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis dataKey="name" type="category" width={96} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="Ocupados" stackId="a" fill="#16a34a" />
                <Bar dataKey="Reservados" stackId="a" fill="#0ea5e9" />
                <Bar dataKey="Libres" stackId="a" fill="#94a3b8" />
                <Bar dataKey="Fuera de servicio" stackId="a" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
      <OccupancyHistoryCard facilityId={facilityId} />
    </div>
  );
}

// ============================================================================
// Churn
// ============================================================================

function ChurnPanel({ facilityId, period }: { facilityId?: string; period: Period }) {
  const churn = useChurn({ from: period.from, to: period.to, facilityId });
  const prev = previousPeriod(period);
  const previous = useChurn({ from: prev.from, to: prev.to, facilityId });

  if (churn.isLoading || !churn.data) {
    return <PanelLoader />;
  }

  const months = churn.data.months;
  const ended = months.reduce((acc, m) => acc + m.ended, 0);
  const prevEnded = previous.data?.months.reduce((acc, m) => acc + m.ended, 0);
  const avgRate = months.length
    ? months.reduce((acc, m) => acc + m.churnRate, 0) / months.length
    : 0;
  const chartData = months.map((m) => ({
    month: m.yearMonth,
    Churn: Number((m.churnRate * 100).toFixed(2)),
  }));

  // El mes en curso aún no ha terminado: el dato que vale es el del último cerrado.
  const currentYm = new Date().toISOString().slice(0, 7);
  const closed = months.filter((m) => m.yearMonth < currentYm);
  const last = closed[closed.length - 1];
  const beforeLast = closed[closed.length - 2];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          title={`Churn de ${last ? monthName(last.yearMonth) : 'último mes cerrado'}`}
          value={last ? `${(last.churnRate * 100).toFixed(2)}%` : '—'}
        >
          {last ? `${last.ended} bajas de ${last.activeAtStart} activos al inicio. ` : '—'}
          {last && beforeLast && (
            <Delta
              current={last.churnRate}
              previous={beforeLast.churnRate}
              goodWhenUp={false}
              suffix="vs mes anterior"
            />
          )}
        </KpiCard>
        <KpiCard title={`Bajas (${periodText(period)})`} value={String(ended)}>
          <Delta current={ended} previous={prevEnded} goodWhenUp={false} />
        </KpiCard>
        <KpiCard title="Churn medio mensual" value={`${(avgRate * 100).toFixed(2)}%`}>
          {months.length} meses analizados
        </KpiCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evolución del churn</CardTitle>
          <CardDescription>
            Contratos dados de baja (finalizados o cancelados tras firmarse) sobre los activos a
            inicio de cada mes. Las reservas online que no se llegaron a pagar no cuentan.
          </CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay datos suficientes todavía.</p>
          ) : (
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 256 }}
            >
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis unit="%" />
                <Tooltip formatter={(v) => `${Number(v) || 0}%`} />
                <Line type="monotone" dataKey="Churn" stroke="#dc2626" strokeWidth={2} dot />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// Morosidad (Aging)
// ============================================================================

const BUCKET_COLORS = ['#16a34a', '#eab308', '#f97316', '#dc2626'];

function AgingPanel({ facilityId }: { facilityId?: string }) {
  const aging = useAging({ facilityId });

  if (aging.isLoading || !aging.data) {
    return <PanelLoader />;
  }

  const d = aging.data;
  const chartData = d.buckets.map((b, i) => ({
    range: b.range,
    Importe: Number(b.amount.toFixed(2)),
    invoices: b.invoiceCount,
    color: BUCKET_COLORS[i % BUCKET_COLORS.length],
  }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <KpiCard title="Total pendiente" value={formatCurrency(d.totalOutstanding)}>
          Facturas vencidas sin cobrar (sin las fianzas)
        </KpiCard>
        <KpiCard
          title="Facturas afectadas"
          value={String(d.buckets.reduce((acc, b) => acc + b.invoiceCount, 0))}
        >
          Distribuidas por antigüedad
        </KpiCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Antigüedad de la deuda</CardTitle>
          <CardDescription>
            Importe pendiente agrupado por días desde el vencimiento.
          </CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          {d.totalOutstanding === 0 ? (
            <p className="text-sm text-muted-foreground">No hay deuda pendiente. ¡Todo al día!</p>
          ) : (
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 256 }}
            >
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="range" />
                <YAxis />
                <Tooltip formatter={(v) => formatCurrency(Number(v) || 0)} />
                <Bar dataKey="Importe">
                  {chartData.map((entry, idx) => (
                    <Cell key={`cell-${idx}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// Leads funnel
// ============================================================================

function LeadsPanel({ facilityId, period }: { facilityId?: string; period: Period }) {
  const range = { ...periodDays(period), facilityId };
  const funnel = useLeadsFunnel(range);
  const previous = useLeadsFunnel({ ...periodDays(previousPeriod(period)), facilityId });

  if (funnel.isLoading || !funnel.data) return <PanelLoader />;

  const d = funnel.data;
  // Embudo acumulado: cuántos llegaron al menos a cada fase.
  const funnelData = [
    { stage: 'Recibidos', count: d.total },
    { stage: 'Contactados', count: d.reached.contacted },
    { stage: 'Cualificados', count: d.reached.qualified },
    { stage: 'Ganados', count: d.reached.won },
  ];
  const sourceData = d.bySource.map((s) => ({
    source: s.source || '(sin origen)',
    count: s.count,
  }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <KpiCard title={`Contactos recibidos (${periodText(period)})`} value={String(d.total)}>
          <Delta current={d.total} previous={previous.data?.total} />
        </KpiCard>
        <KpiCard title="Ganados" value={String(d.reached.won)}>
          <Delta current={d.reached.won} previous={previous.data?.reached.won} />
        </KpiCard>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard title="Nuevo → Contactado" value={formatPercent(d.conversion.newToContacted)}>
          Tasa de respuesta
        </KpiCard>
        <KpiCard
          title="Contactado → Cualificado"
          value={formatPercent(d.conversion.contactedToQualified)}
        >
          Calidad del lead
        </KpiCard>
        <KpiCard title="Cualificado → Ganado" value={formatPercent(d.conversion.qualifiedToWon)}>
          Cierre efectivo
        </KpiCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Embudo</CardTitle>
          <CardDescription>
            {d.total} contactos recibidos del {formatDay(d.from)} al {formatDay(d.to)}: cuántos
            llegaron a cada fase. Ahora mismo: {d.totals.new} nuevos, {d.totals.contacted}{' '}
            contactados, {d.totals.qualified} cualificados, {d.totals.won} ganados y {d.totals.lost}{' '}
            perdidos.
          </CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 300, height: 256 }}
          >
            <BarChart data={funnelData} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis dataKey="stage" type="category" width={96} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Por origen</CardTitle>
          <CardDescription>De dónde llegan los leads.</CardDescription>
        </CardHeader>
        <CardContent className="h-64">
          {sourceData.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay leads todavía.</p>
          ) : (
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 256 }}
            >
              <BarChart data={sourceData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="source" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="count" fill="#8b5cf6" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Por qué se pierden</CardTitle>
          <CardDescription>
            Motivo de los leads perdidos del periodo (se pide al pasarlos a «Perdidos»).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {d.lostReasons.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay leads perdidos en el periodo.</p>
          ) : (
            <ul className="space-y-2">
              {d.lostReasons.map((r) => {
                const pct = d.totals.lost > 0 ? (r.count / d.totals.lost) * 100 : 0;
                return (
                  <li key={r.reason} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span>
                        {r.reason in LEAD_LOST_REASON_LABELS
                          ? LEAD_LOST_REASON_LABELS[r.reason as LeadLostReason]
                          : 'Sin motivo indicado'}
                      </span>
                      <span className="text-muted-foreground">
                        {r.count} · {Math.round(pct)} %
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-rose-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <LeadsUtmCard range={range} />
    </div>
  );
}

function LeadsUtmCard({ range }: { range: { from: string; to: string; facilityId?: string } }) {
  const utm = useLeadsUtm(range);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Campañas (UTM)</CardTitle>
          <CardDescription>
            Conversión por origen y campaña de los leads que llegan con parámetros{' '}
            <code className="text-xs">utm_*</code> en la URL (widget / booking), en el mismo
            periodo.
          </CardDescription>
        </div>
        <CsvButton
          disabled={!utm.data?.rows.length}
          filename="campanas-utm.csv"
          rows={() => [
            ['Origen', 'Campaña', 'Contactos', 'Ganados', 'Conversión'],
            ...(utm.data?.rows ?? []).map((u) => [
              u.source,
              u.campaign,
              u.total,
              u.won,
              Math.round(u.conversionRate * 1000) / 10,
            ]),
          ]}
        />
      </CardHeader>
      <CardContent>
        {utm.isLoading || !utm.data ? (
          <PanelLoader />
        ) : utm.data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay leads con tracking UTM. Comparte el enlace del widget con parámetros, p. ej.{' '}
            <code className="text-xs">?utm_source=google&utm_campaign=verano</code>.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Origen</TableHead>
                <TableHead>Campaña</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Ganados</TableHead>
                <TableHead className="text-right">Conversión</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {utm.data.rows.map((r) => (
                <TableRow key={`${r.source}|${r.campaign}`}>
                  <TableCell className="font-medium">{r.source}</TableCell>
                  <TableCell>{r.campaign}</TableCell>
                  <TableCell className="text-right">{r.total}</TableCell>
                  <TableCell className="text-right">{r.won}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatPercent(r.conversionRate)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Riesgo de baja (churn risk heurístico)
// ============================================================================

const RISK_BADGE: Record<ChurnRiskLevel, { label: string; className: string }> = {
  high: {
    label: 'Alto',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 hover:bg-red-100',
  },
  medium: {
    label: 'Medio',
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-950',
  },
  low: {
    label: 'Bajo',
    className:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-950',
  },
};

function ChurnRiskPanel({ facilityId }: { facilityId?: string }) {
  const risk = useChurnRisk(facilityId);

  if (risk.isLoading || !risk.data) {
    return <PanelLoader />;
  }

  const d = risk.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard title="Riesgo alto" value={String(d.summary.high)}>
          Contratos que requieren acción inmediata
        </KpiCard>
        <KpiCard title="Riesgo medio" value={String(d.summary.medium)}>
          Vigilar de cerca
        </KpiCard>
        <KpiCard title="Contratos activos" value={String(d.summary.total)}>
          Analizados en total
        </KpiCard>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Contratos en riesgo</CardTitle>
            <CardDescription>
              Puntuación (0-100) según facturas vencidas, cobros fallidos y reclamaciones (lo de los
              últimos 90 días pesa más), vencimiento sin renovación, no tener cómo pagar solo
              (tarjeta, cuenta o mandato SEPA) y no haber entrado al local en 90 días.
            </CardDescription>
          </div>
          <CsvButton
            disabled={d.items.length === 0}
            filename="riesgo-de-baja.csv"
            rows={() => [
              [
                'Contrato',
                'Inquilino',
                'Trastero',
                'Local',
                'Cuota',
                'Puntuación',
                'Último acceso',
                'Señales',
              ],
              ...d.items.map((i) => [
                i.contractNumber,
                i.customerName,
                i.unitCode,
                i.facilityName,
                i.priceMonthly,
                i.score,
                i.lastAccessAt ? new Date(i.lastAccessAt).toLocaleDateString('es-ES') : '',
                i.factors.join(' · '),
              ]),
            ]}
          />
        </CardHeader>
        <CardContent>
          {d.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hay contratos con señales de riesgo. ¡Buena retención!
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contrato</TableHead>
                  <TableHead>Inquilino</TableHead>
                  <TableHead>Trastero</TableHead>
                  <TableHead className="text-right">Cuota</TableHead>
                  <TableHead>Riesgo</TableHead>
                  <TableHead>Señales</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.items.map((item) => (
                  <TableRow key={item.contractId}>
                    <TableCell className="font-medium">
                      <Link href={`/contracts/${item.contractId}`} className="hover:underline">
                        {item.contractNumber}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/customers/${item.customerId}`} className="hover:underline">
                        {item.customerName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {item.unitCode}
                      <span className="block text-xs text-muted-foreground">
                        {item.facilityName}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(item.priceMonthly)}
                    </TableCell>
                    <TableCell>
                      <Badge className={RISK_BADGE[item.level].className} variant="secondary">
                        {RISK_BADGE[item.level].label} · {item.score}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.factors.join(' · ')}
                      {item.lastAccessAt && (
                        <span className="block">
                          Último acceso: {new Date(item.lastAccessAt).toLocaleDateString('es-ES')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="outline">
                        {item.contractStatus === 'ending' ? (
                          <Link href={`/contracts/${item.contractId}`}>Ofrecer retención</Link>
                        ) : (
                          <Link href={`/customers/${item.customerId}`}>Ver ficha</Link>
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// Precio dinámico (sugerencias por ocupación)
// ============================================================================

const PRICING_BADGE: Record<PricingAction, { label: string; className: string }> = {
  raise: {
    label: 'Subir',
    className:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-950',
  },
  lower: {
    label: 'Bajar',
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-950',
  },
  hold: {
    label: 'Mantener',
    className:
      'bg-slate-100 text-slate-600 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-800',
  },
};

function PricingSuggestionsPanel({ facilityId }: { facilityId?: string }) {
  const ask = useConfirm();
  const pricing = usePricingSuggestions(facilityId);
  const apply = useApplyPricing();
  const canApply = useHasPermission('units:manage');

  if (pricing.isLoading || !pricing.data) {
    return <PanelLoader />;
  }

  const items = pricing.data.items;

  async function applySuggestion(unitTypeId: string, name: string, price: number) {
    if (
      !(await ask({
        title: '¿Seguro?',
        description: `¿Fijar el precio de catálogo de "${name}" en ${formatCurrency(price)}? Afecta a los nuevos contratos; los activos no cambian.`,
      }))
    )
      return;
    try {
      await apply.mutateAsync({ unitTypeId, price });
      toast.success('Precio actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo aplicar.');
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Sugerencias de precio</CardTitle>
          <CardDescription>
            Precio de mercado del tamaño medio de cada tipo ajustado por la demanda (ocupación y
            lista de espera). Aplicar fija el <strong>precio de catálogo</strong> del tipo (nuevos
            contratos); los contratos activos no cambian — para subir la cartera usa{' '}
            <em>Subidas de precio</em>.
          </CardDescription>
        </div>
        <CsvButton
          disabled={items.length === 0}
          filename="precios-por-tipo.csv"
          rows={() => [
            ['Tipo', 'Ocupación', 'Mercado', 'Precio actual', 'Sugerido'],
            ...items.map((i) => [
              i.unitTypeName,
              Math.round(i.occupancy),
              i.marketPrice ?? '',
              i.currentPrice,
              i.suggestedPrice,
            ]),
          ]}
        />
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay tipos de trastero con datos suficientes.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Ocupación</TableHead>
                <TableHead className="text-right">Mercado</TableHead>
                <TableHead className="text-right">Precio actual</TableHead>
                <TableHead className="text-right">Sugerido</TableHead>
                <TableHead>Acción</TableHead>
                <TableHead>Motivo</TableHead>
                {canApply && <TableHead className="text-right">Aplicar</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.unitTypeId}>
                  <TableCell className="font-medium">
                    {item.unitTypeName}
                    <span className="block text-xs text-muted-foreground">
                      {item.occupiedUnits}/{item.totalUnits} ocupados
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{item.occupancy.toFixed(0)}%</TableCell>
                  <TableCell className="text-right">
                    {item.marketPrice != null ? formatCurrency(item.marketPrice) : '—'}
                    {item.marketTrend && <TrendNote trend={item.marketTrend} />}
                    <span
                      className="block text-xs text-muted-foreground"
                      title={CONFIDENCE[item.confidence].title}
                    >
                      {CONFIDENCE[item.confidence].label}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{formatCurrency(item.currentPrice)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCurrency(item.suggestedPrice)}
                    {item.changePct !== 0 && (
                      <span
                        className={`ml-1 text-xs ${
                          item.changePct > 0 ? 'text-emerald-600' : 'text-amber-600'
                        }`}
                      >
                        ({item.changePct > 0 ? '+' : ''}
                        {item.changePct}%)
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge className={PRICING_BADGE[item.action].className} variant="secondary">
                      {PRICING_BADGE[item.action].label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.rationale}</TableCell>
                  {canApply && (
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={apply.isPending || item.action === 'hold'}
                        onClick={() =>
                          void applySuggestion(
                            item.unitTypeId,
                            item.unitTypeName,
                            item.suggestedPrice,
                          )
                        }
                      >
                        Aplicar
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Previsión (forecasting de ocupación e ingresos)
// ============================================================================

function ForecastPanel({ facilityId }: { facilityId?: string }) {
  const forecast = useRevenueForecast({ months: 6, facilityId });

  if (forecast.isLoading || !forecast.data) {
    return <PanelLoader />;
  }

  const d = forecast.data;
  const chartData = [
    {
      month: 'Actual',
      MRR: Number(d.current.mrr.toFixed(2)),
      Ocupación: Number((d.current.occupancy * 100).toFixed(1)),
    },
    ...d.points.map((p) => ({
      month: p.yearMonth,
      MRR: Number(p.projectedMrr.toFixed(2)),
      Ocupación: Number((p.projectedOccupancy * 100).toFixed(1)),
    })),
  ];
  const lastPoint = d.points[d.points.length - 1];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="MRR actual" value={formatCurrency(d.current.mrr)}>
          {d.current.activeContracts} contratos activos
        </KpiCard>
        <KpiCard
          title={`MRR previsto (+${d.points.length}m)`}
          value={lastPoint ? formatCurrency(lastPoint.projectedMrr) : '—'}
        >
          {lastPoint ? `${lastPoint.projectedActiveContracts} contratos proyectados` : '—'}
        </KpiCard>
        <KpiCard
          title="Churn medio mensual"
          value={`${(d.assumptions.monthlyChurnRate * 100).toFixed(1)}%`}
        >
          Media de los últimos {d.assumptions.trailingMonths} meses
        </KpiCard>
        <KpiCard title="Altas medias / mes" value={d.assumptions.avgMonthlyNewContracts.toFixed(1)}>
          Valor medio {formatCurrency(d.assumptions.avgContractValue)}/contrato
        </KpiCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Proyección a {d.points.length} meses</CardTitle>
          <CardDescription>
            Estimación heurística basada en la tendencia reciente (churn y altas medias). No es una
            garantía: cuanto más histórico, más fiable.
          </CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 300, height: 256 }}
          >
            <AreaChart data={chartData} margin={{ left: 8, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" />
              <YAxis yAxisId="mrr" tickFormatter={(v) => compactEuros(Number(v) || 0)} />
              <YAxis yAxisId="occ" orientation="right" unit="%" domain={[0, 100]} />
              <Tooltip
                formatter={(value, name) =>
                  name === 'MRR' ? formatCurrency(Number(value) || 0) : `${Number(value) || 0}%`
                }
              />
              <Legend />
              <Area
                yAxisId="mrr"
                type="monotone"
                dataKey="MRR"
                stroke="#2563eb"
                fill="#2563eb"
                fillOpacity={0.15}
                strokeWidth={2}
              />
              <Area
                yAxisId="occ"
                type="monotone"
                dataKey="Ocupación"
                stroke="#16a34a"
                fill="#16a34a"
                fillOpacity={0.1}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

// ============================================================================
// Comparativa de mercado (benchmarking anónimo)
// ============================================================================

function BenchmarkMetricRow({
  label,
  metric,
  format,
  hint,
}: {
  label: string;
  metric: BenchmarkMetricDto;
  format: (value: number) => string;
  hint?: string;
}) {
  // Posición de "tú" y de la mediana en la barra p25→p75 (acotado a [0,100]).
  const span = metric.p75 - metric.p25;
  const pos = (value: number) =>
    span <= 0 ? 50 : Math.max(0, Math.min(100, ((value - metric.p25) / span) * 100));
  const minePos = pos(metric.mine);
  const medianPos = pos(metric.median);
  const aboveMedian = metric.mine >= metric.median;

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Badge variant={aboveMedian ? 'default' : 'secondary'}>
          Percentil {metric.myPercentile}
        </Badge>
      </div>
      <div className="flex items-baseline justify-between text-sm">
        <span>
          Tú: <span className="font-semibold">{format(metric.mine)}</span>
        </span>
        <span className="text-muted-foreground">Mediana del sector: {format(metric.median)}</span>
      </div>
      {/* Barra p25 → p75 con marcadores de mediana (gris) y del tenant (azul). */}
      <div className="relative h-2 rounded-full bg-muted">
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-400"
          style={{ left: `${medianPos}%` }}
          title={`Mediana: ${format(metric.median)}`}
        />
        <div
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow"
          style={{ left: `${minePos}%` }}
          title={`Tú: ${format(metric.mine)}`}
        />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>p25: {format(metric.p25)}</span>
        <span>p75: {format(metric.p75)}</span>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function BenchmarkPanel() {
  const benchmark = useBenchmark();

  if (benchmark.isLoading || !benchmark.data) {
    return <PanelLoader />;
  }

  const d = benchmark.data;

  if (!d.available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Comparativa del sector</CardTitle>
          <CardDescription>
            Compara tu ocupación y precios con la media anónima del sector.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Datos insuficientes para comparar (se necesitan al menos 5 operadores con contratos). La
            comparativa se activará automáticamente a medida que crezca la red.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Comparativa del sector</CardTitle>
        <CardDescription>
          Tu posición frente a la media anónima de {d.sampleSize} operadores de self-storage. Los
          datos del sector son agregados y anónimos: nunca se muestran valores individuales de otros
          operadores.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {d.occupancy && (
          <BenchmarkMetricRow
            label="Ocupación física"
            metric={d.occupancy}
            format={(v) => `${v.toFixed(1)}%`}
            hint="Trasteros ocupados sobre el total."
          />
        )}
        {d.price && (
          <BenchmarkMetricRow
            label="Precio medio por trastero"
            metric={d.price}
            format={formatCurrency}
            hint="Cuota mensual media de tus trasteros."
          />
        )}
        {d.pricePerSqm && (
          <BenchmarkMetricRow
            label="Precio por m²"
            metric={d.pricePerSqm}
            format={(v) => `${formatCurrency(v)}/m²`}
            hint="Cuota mensual media por metro cuadrado."
          />
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Checklist de SEO on-page
// ============================================================================

function ScoreBadge({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : done / total;
  const className =
    pct === 1
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 hover:bg-emerald-100'
      : pct >= 0.5
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 hover:bg-amber-100'
        : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 hover:bg-red-100';
  return (
    <Badge className={className} variant="secondary">
      {done}/{total}
    </Badge>
  );
}

function ChecklistRow({ item }: { item: SeoChecklistItemDto }) {
  return (
    <div className="flex items-start gap-3 border-b py-3 last:border-0">
      {item.done ? (
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
      ) : (
        <CircleDashed className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.label}</p>
        <p className="text-xs text-muted-foreground">{item.description}</p>
        {item.detail && <p className="mt-0.5 text-xs text-amber-600">{item.detail}</p>}
      </div>
      {!item.done && (
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link href={item.href}>Arreglar</Link>
        </Button>
      )}
    </div>
  );
}

function SeoChecklistPanel() {
  const checklist = useSeoChecklist();

  if (checklist.isLoading || !checklist.data) {
    return <PanelLoader />;
  }

  const d = checklist.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">
              Básico (todos los planes)
            </CardTitle>
            <ScoreBadge done={d.baseScore.done} total={d.baseScore.total} />
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">
              Web Premium {!d.hasWebPremium && '(no activada)'}
            </CardTitle>
            <ScoreBadge done={d.premiumScore.done} total={d.premiumScore.total} />
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Checklist básico</CardTitle>
          <CardDescription>
            Aplica a cualquier plan: refuerza el SEO local y la confianza de tu web pública.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {d.base.map((item) => (
            <ChecklistRow key={item.id} item={item} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Checklist Web Premium</CardTitle>
          <CardDescription>
            Plantilla personalizada, FAQ, testimonios, formulario de contacto y blog.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!d.hasWebPremium ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              Activa <strong>Web Premium</strong> para desbloquear plantillas de diseño, textos
              propios, FAQ, testimonios, formulario de contacto y blog — el resto de la palanca de
              SEO de contenido.{' '}
              <Link href="/settings/saas-billing" className="text-primary underline">
                Ver planes
              </Link>
              .
            </div>
          ) : (
            d.premium.map((item) => <ChecklistRow key={item.id} item={item} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KpiCard({
  title,
  value,
  children,
}: {
  title: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {children && <div className="mt-1 text-xs text-muted-foreground">{children}</div>}
      </CardContent>
    </Card>
  );
}

/** «sep 26» → «septiembre 2026» a partir de YYYY-MM. */
function monthName(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, 1)).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatDay(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Eje de importes: «850 €», «12,5k €». */
function compactEuros(v: number): string {
  if (Math.abs(v) < 1000) return `${Math.round(v)} €`;
  return `${(v / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })}k €`;
}

function PanelLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function MonthlyRevenuePanel({ facilityId, period }: { facilityId?: string; period: Period }) {
  const revenue = useMonthlyRevenue({ from: period.from, to: period.to, facilityId });
  const prev = previousPeriod(period);
  const previous = useMonthlyRevenue({ from: prev.from, to: prev.to, facilityId });

  if (revenue.isLoading || !revenue.data) return <PanelLoader />;

  const points = revenue.data.points;
  const totalInvoiced = points.reduce((acc, p) => acc + p.invoiced, 0);
  const totalCollected = points.reduce((acc, p) => acc + p.collected, 0);
  const prevPoints = previous.data?.points;
  const prevInvoiced = prevPoints?.reduce((acc, p) => acc + p.invoiced, 0);
  const prevCollected = prevPoints?.reduce((acc, p) => acc + p.collected, 0);
  const chartData = points.map((p) => ({
    mes: p.label,
    Facturado: p.invoiced,
    Cobrado: p.collected,
  }));
  const periodLabel = periodText(period);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <KpiCard title={`Facturado (${periodLabel})`} value={formatCurrency(totalInvoiced)}>
          <Delta current={totalInvoiced} previous={prevInvoiced} />
        </KpiCard>
        <KpiCard title={`Cobrado (${periodLabel})`} value={formatCurrency(totalCollected)}>
          <Delta current={totalCollected} previous={prevCollected} />
        </KpiCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ingresos por mes</CardTitle>
          <CardDescription>Facturado (emitido) y cobrado · {periodLabel}.</CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          {totalInvoiced === 0 && totalCollected === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hay ingresos registrados en el periodo seleccionado.
            </p>
          ) : (
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 256 }}
            >
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="mes" />
                <YAxis tickFormatter={(v) => compactEuros(Number(v) || 0)} />
                <Tooltip formatter={(v) => formatCurrency(Number(v) || 0)} />
                <Legend />
                <Bar dataKey="Facturado" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Cobrado" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <RevenueBreakdownCard facilityId={facilityId} period={period} />

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Detalle mensual</CardTitle>
          <CsvButton
            filename={`ingresos-${period.from}-${period.to}.csv`}
            rows={() => [
              ['Mes', 'Facturado', 'Cobrado'],
              ...points.map((p) => [p.yearMonth, p.invoiced, p.collected]),
            ]}
          />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mes</TableHead>
                <TableHead className="text-right">Facturado</TableHead>
                <TableHead className="text-right">Cobrado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {points
                .slice()
                .reverse()
                .map((p) => (
                  <TableRow key={p.yearMonth}>
                    <TableCell>{p.label}</TableCell>
                    <TableCell className="text-right">{formatCurrency(p.invoiced)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(p.collected)}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

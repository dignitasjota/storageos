'use client';

import { LEAD_LOST_REASON_LABELS, leadSourceLabel, type LeadLostReason } from '@storageos/shared';
import { CheckCircle2, CircleDashed } from 'lucide-react';
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
  includesCurrentMonth,
  type Period,
  PeriodSelector,
  periodDays,
  periodPresets,
  periodText,
  previousPeriod,
  previousPeriodDays,
} from './period';
import { PreOpeningCard } from './pre-opening-card';
import { PriceChangeEffectsPanel } from './price-change-effects-panel';
import { PricingStrategyButton } from './pricing-strategy-dialog';
import { CohortsPanel, OccupancyHistoryCard, RevenueBreakdownCard } from './trends-panels';
import {
  ChartData,
  currentYearMonth,
  eur,
  formatPct,
  IssuerSelect,
  KpiCard,
  monthName,
  QueryState,
  shortMonth,
} from './ui';
import { CONFIDENCE, TrendNote, UnitPricingPanel } from './unit-pricing-panel';

import type {
  BenchmarkMetricDto,
  ChurnKpiDto,
  ChurnRiskLevel,
  MonthlyRevenuePointDto,
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
  useExitReasons,
  useLeadsFunnel,
  useLeadsUtm,
  useMonthlyRevenue,
  useOccupancy,
  usePricingSuggestions,
  useRevenueForecast,
  useSeoChecklist,
} from '@/lib/analytics/hooks';
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
import { formatDate } from '@/lib/format';

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

/** Pestañas que enseñan el dinero facturado y cobrado. */
const MONEY_TABS: AnalyticsTab[] = ['revenue', 'aging'];
/** Pestañas donde el local elegido no filtra nada. */
const COMPANY_TABS: AnalyticsTab[] = ['market', 'seo'];
/** Pestañas que separan las facturas de cada emisor (plan Administrador). */
const ISSUER_TABS: AnalyticsTab[] = ['revenue', 'aging', 'cohorts'];

type PricingSubTab = 'by-type' | 'by-unit' | 'effects';

export default function AnalyticsPage() {
  // Permiso para ver el dinero (facturas y cobros), como en el Resumen.
  const canInvoices = useHasPermission('invoices:read');
  const canPayments = useHasPermission('payments:read');
  const moneyVisible = canInvoices && canPayments;

  // Pestaña inicial desde `?tab=`: hasta leerla no se monta ninguna (si no, la
  // primera pediría sus datos para nada).
  const [tab, setTab] = useState<AnalyticsTab | null>(null);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    const valid =
      requested && (ANALYTICS_TABS as readonly string[]).includes(requested)
        ? (requested as AnalyticsTab)
        : null;
    setTab(valid ?? 'revenue');
  }, []);
  const shownTab = tab && !moneyVisible && MONEY_TABS.includes(tab) ? ('occupancy' as const) : tab;

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
  // Lo que se elige dentro de cada pestaña no se pierde al cambiar de pestaña.
  const [issuer, setIssuer] = useState('self');
  const [pricingTab, setPricingTab] = useState<PricingSubTab>('by-type');
  const [includeCompetition, setIncludeCompetition] = useState(true);
  const [occupancyMonths, setOccupancyMonths] = useState(12);
  const [cohortMonths, setCohortMonths] = useState(24);
  const ownerId = issuer === 'self' ? undefined : issuer;

  const usesPeriod = shownTab === 'revenue' || shownTab === 'churn' || shownTab === 'leads';

  return (
    <div className="min-w-0 space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analítica</h1>
          <p className="text-sm text-muted-foreground">
            Cómo va el negocio: ingresos, ocupación, bajas, deudas, contactos y precios.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {shownTab && ISSUER_TABS.includes(shownTab) && (
            <IssuerSelect value={issuer} onChange={setIssuer} />
          )}
          {facilityList.length > 1 && shownTab && !COMPANY_TABS.includes(shownTab) && (
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
      </div>

      {usesPeriod && <PeriodSelector value={period} onChange={setPeriod} />}

      {shownTab && (
        <Tabs value={shownTab} onValueChange={handleTabChange} className="w-full">
          {/* Varias filas si no caben: ninguna pestaña queda escondida. */}
          <TabsList className="h-auto flex-wrap justify-start">
            {moneyVisible && <TabsTrigger value="revenue">Ingresos</TabsTrigger>}
            <TabsTrigger value="occupancy">Ocupación</TabsTrigger>
            <TabsTrigger value="churn">Bajas</TabsTrigger>
            <TabsTrigger value="cohorts">Permanencia</TabsTrigger>
            {moneyVisible && <TabsTrigger value="aging">Deudas</TabsTrigger>}
            <TabsTrigger value="leads">Contactos</TabsTrigger>
            <TabsTrigger value="churn-risk">Riesgo de baja</TabsTrigger>
            <TabsTrigger value="pricing">Precios</TabsTrigger>
            <TabsTrigger value="forecast">Previsión</TabsTrigger>
            <TabsTrigger value="market">Comparativa del sector</TabsTrigger>
            <TabsTrigger value="seo">SEO</TabsTrigger>
          </TabsList>
          {moneyVisible && (
            <TabsContent value="revenue" className="mt-4">
              <MonthlyRevenuePanel facilityId={facilityId} period={period} ownerId={ownerId} />
            </TabsContent>
          )}
          <TabsContent value="occupancy" className="mt-4">
            <OccupancyPanel
              facilityId={facilityId}
              months={occupancyMonths}
              onMonthsChange={setOccupancyMonths}
            />
          </TabsContent>
          <TabsContent value="churn" className="mt-4">
            <ChurnPanel facilityId={facilityId} period={period} />
          </TabsContent>
          <TabsContent value="cohorts" className="mt-4">
            <CohortsPanel
              facilityId={facilityId}
              ownerId={ownerId}
              months={cohortMonths}
              onMonthsChange={setCohortMonths}
            />
          </TabsContent>
          {moneyVisible && (
            <TabsContent value="aging" className="mt-4">
              <AgingPanel facilityId={facilityId} ownerId={ownerId} />
            </TabsContent>
          )}
          <TabsContent value="leads" className="mt-4">
            <LeadsPanel facilityId={facilityId} period={period} />
          </TabsContent>
          <TabsContent value="churn-risk" className="mt-4">
            <ChurnRiskPanel facilityId={facilityId} />
          </TabsContent>
          <TabsContent value="pricing" className="mt-4">
            <Tabs
              value={pricingTab}
              onValueChange={(v) => setPricingTab(v as PricingSubTab)}
              className="w-full"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <TabsList className="h-auto flex-wrap justify-start">
                  <TabsTrigger value="by-type">Por tipo de trastero</TabsTrigger>
                  <TabsTrigger value="by-unit">Por trastero</TabsTrigger>
                  <TabsTrigger value="effects">Efecto de tus cambios</TabsTrigger>
                </TabsList>
                <PricingStrategyButton />
              </div>
              <TabsContent value="by-type" className="mt-4">
                <PricingSuggestionsPanel facilityId={facilityId} />
              </TabsContent>
              <TabsContent value="by-unit" className="mt-4">
                <UnitPricingPanel
                  facilityId={facilityId}
                  includeCompetition={includeCompetition}
                  onIncludeCompetitionChange={setIncludeCompetition}
                />
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
      )}
    </div>
  );
}

// ============================================================================
// Ingresos
// ============================================================================

/**
 * Totales que se pueden comparar: si el periodo llega al mes en curso (que va
 * a medias), se comparan solo los meses cerrados de los dos periodos.
 */
function comparableTotals(
  points: MonthlyRevenuePointDto[],
  prevPoints: MonthlyRevenuePointDto[] | undefined,
  partial: boolean,
) {
  const sum = (list: MonthlyRevenuePointDto[], key: 'invoiced' | 'collected') =>
    list.reduce((acc, p) => acc + p[key], 0);
  if (!prevPoints) return null;
  const cur = partial ? points.slice(0, -1) : points;
  const prev = partial ? prevPoints.slice(0, -1) : prevPoints;
  if (cur.length === 0) return null;
  return {
    invoiced: [sum(cur, 'invoiced'), sum(prev, 'invoiced')] as const,
    collected: [sum(cur, 'collected'), sum(prev, 'collected')] as const,
  };
}

function MonthlyRevenuePanel({
  facilityId,
  period,
  ownerId,
}: {
  facilityId?: string;
  period: Period;
  ownerId?: string;
}) {
  const revenue = useMonthlyRevenue({ from: period.from, to: period.to, facilityId, ownerId });
  const prev = previousPeriod(period);
  const previous = useMonthlyRevenue({ from: prev.from, to: prev.to, facilityId, ownerId });
  const partial = includesCurrentMonth(period);
  const suffix = partial ? 'vs periodo anterior (meses cerrados)' : 'vs periodo anterior';

  return (
    <QueryState query={revenue}>
      {(data) => {
        const points = data.points;
        const totalInvoiced = points.reduce((acc, p) => acc + p.invoiced, 0);
        const totalCollected = points.reduce((acc, p) => acc + p.collected, 0);
        const compare = comparableTotals(points, previous.data?.points, partial);
        const chartData = points.map((p) => ({
          mes: p.label,
          Facturado: p.invoiced,
          Cobrado: p.collected,
        }));
        const periodLabel = periodText(period);
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <KpiCard title={`Facturado (${periodLabel}, con IVA)`} value={eur(totalInvoiced)}>
                {compare && (
                  <Delta
                    current={compare.invoiced[0]}
                    previous={compare.invoiced[1]}
                    suffix={suffix}
                  />
                )}
              </KpiCard>
              <KpiCard title={`Cobrado (${periodLabel})`} value={eur(totalCollected)}>
                {compare && (
                  <Delta
                    current={compare.collected[0]}
                    previous={compare.collected[1]}
                    suffix={suffix}
                  />
                )}
              </KpiCard>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ingresos por mes</CardTitle>
                <CardDescription>
                  Facturado (emitido, con IVA) y cobrado · {periodLabel}.
                </CardDescription>
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
                      <Tooltip formatter={(v) => eur(Number(v) || 0)} />
                      <Legend />
                      <Bar dataKey="Facturado" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="Cobrado" fill="#2563eb" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <RevenueBreakdownCard facilityId={facilityId} period={period} ownerId={ownerId} />

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <CardTitle className="text-base">Detalle mensual</CardTitle>
                <CsvButton
                  filename={`ingresos-${period.from}-${period.to}.csv`}
                  rows={() => [
                    ['Mes', 'Facturado (con IVA)', 'Cobrado'],
                    ...points.map((p) => [p.label, p.invoiced, p.collected]),
                  ]}
                />
              </CardHeader>
              <CardContent className="overflow-x-auto">
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
                          <TableCell className="text-right">{eur(p.invoiced)}</TableCell>
                          <TableCell className="text-right font-medium">
                            {eur(p.collected)}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}

// ============================================================================
// Ocupación
// ============================================================================

function OccupancyPanel({
  facilityId,
  months,
  onMonthsChange,
}: {
  facilityId?: string;
  months: number;
  onMonthsChange: (n: number) => void;
}) {
  const occupancy = useOccupancy({ facilityId });

  return (
    <div className="space-y-4">
      <QueryState query={occupancy}>
        {(d) => {
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
                <KpiCard title="Ocupación física" value={formatPct(d.physicalOccupancy)}>
                  {d.occupiedUnits} de {d.totalUnits} trasteros
                </KpiCard>
                {d.economicOccupancy !== null && (
                  <KpiCard title="Ocupación económica" value={formatPct(d.economicOccupancy)}>
                    Lo que ingresas frente a lo que ingresarías con todo alquilado
                  </KpiCard>
                )}
                {d.mrrActual !== null && (
                  <KpiCard title="Cuotas al mes" value={eur(d.mrrActual)}>
                    Lo que pagan al mes los inquilinos de hoy, sin IVA y con sus descuentos
                  </KpiCard>
                )}
                {d.mrrPotential !== null && (
                  <KpiCard title="Cuotas con todo alquilado" value={eur(d.mrrPotential)}>
                    El precio de cada trastero que se puede alquilar
                    {d.outOfServiceUnits > 0
                      ? ` (sin los ${d.outOfServiceUnits} fuera de servicio)`
                      : ''}
                  </KpiCard>
                )}
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Ocupación por local</CardTitle>
                  <CardDescription>
                    Trasteros ocupados, reservados, libres y fuera de servicio (mantenimiento o
                    bloqueados) de cada local. Los locales por abrir no cuentan hasta que abren.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {chartData.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No hay locales todavía.</p>
                  ) : (
                    <>
                      <div className="h-80">
                        <ResponsiveContainer
                          width="100%"
                          height="100%"
                          initialDimension={{ width: 300, height: 256 }}
                        >
                          <BarChart data={chartData} layout="vertical" margin={{ left: 24 }}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                            <YAxis
                              dataKey="name"
                              type="category"
                              width={96}
                              tick={{ fontSize: 11 }}
                            />
                            <Tooltip />
                            <Legend />
                            <Bar dataKey="Ocupados" stackId="a" fill="#16a34a" />
                            <Bar dataKey="Reservados" stackId="a" fill="#0ea5e9" />
                            <Bar dataKey="Libres" stackId="a" fill="#94a3b8" />
                            <Bar dataKey="Fuera de servicio" stackId="a" fill="#f59e0b" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <ChartData
                        headers={['Local', 'Ocupados', 'Reservados', 'Libres', 'Fuera de servicio']}
                        rows={d.perFacility.map((f) => [
                          f.facilityName,
                          f.occupied,
                          f.reserved,
                          f.available,
                          f.outOfService,
                        ])}
                      />
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          );
        }}
      </QueryState>
      <PreOpeningCard facilityId={facilityId} />
      <OccupancyHistoryCard
        facilityId={facilityId}
        months={months}
        onMonthsChange={onMonthsChange}
      />
    </div>
  );
}

// ============================================================================
// Bajas
// ============================================================================

function ChurnPanel({ facilityId, period }: { facilityId?: string; period: Period }) {
  const churn = useChurn({ from: period.from, to: period.to, facilityId });
  const prev = previousPeriod(period);
  const previous = useChurn({ from: prev.from, to: prev.to, facilityId });

  return (
    <div className="space-y-4">
      <QueryState query={churn}>
        {(data) => (
          <ChurnBody months={data.months} previous={previous.data?.months} period={period} />
        )}
      </QueryState>
      <ExitReasonsCard facilityId={facilityId} period={period} />
    </div>
  );
}

function ChurnBody({
  months,
  previous,
  period,
}: {
  months: ChurnKpiDto['months'];
  previous: ChurnKpiDto['months'] | undefined;
  period: Period;
}) {
  // El mes en curso aún no ha terminado: las medias y la comparación van con
  // los meses cerrados.
  const currentYm = currentYearMonth();
  const closed = months.filter((m) => m.yearMonth < currentYm);
  const partial = closed.length < months.length;
  const ended = months.reduce((acc, m) => acc + m.ended, 0);
  const closedEnded = closed.reduce((acc, m) => acc + m.ended, 0);
  const prevClosed = previous ? (partial ? previous.slice(0, -1) : previous) : undefined;
  const prevEnded = prevClosed?.reduce((acc, m) => acc + m.ended, 0);
  const avgRate = closed.length
    ? closed.reduce((acc, m) => acc + m.churnRate, 0) / closed.length
    : null;
  const last = closed[closed.length - 1];
  const beforeLast = closed[closed.length - 2];
  const chartData = months.map((m) => ({
    mes: shortMonth(m.yearMonth),
    Bajas: Math.round(m.churnRate * 1000) / 10,
  }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          title={`Bajas de ${last ? monthName(last.yearMonth) : 'último mes cerrado'}`}
          value={last ? formatPct(last.churnRate) : '—'}
        >
          {last
            ? `${last.ended} ${last.ended === 1 ? 'baja' : 'bajas'} de ${last.activeAtStart + last.started} contratos (${last.activeAtStart} al empezar y ${last.started} ${last.started === 1 ? 'alta' : 'altas'}). `
            : '—'}
          {last && beforeLast && (
            <Delta
              current={last.churnRate}
              previous={beforeLast.churnRate}
              goodWhenUp={false}
              suffix="vs mes anterior"
              kind="rate"
            />
          )}
        </KpiCard>
        <KpiCard title={`Bajas (${periodText(period)})`} value={String(ended)}>
          <Delta
            current={closedEnded}
            previous={prevEnded}
            goodWhenUp={false}
            kind="count"
            suffix={partial ? 'vs periodo anterior (meses cerrados)' : 'vs periodo anterior'}
          />
        </KpiCard>
        <KpiCard
          title="Tasa de bajas media al mes"
          value={avgRate === null ? '—' : formatPct(avgRate, 2)}
        >
          {closed.length} {closed.length === 1 ? 'mes cerrado' : 'meses cerrados'}
        </KpiCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tasa de bajas por mes</CardTitle>
          <CardDescription>
            Contratos que se dieron de baja (terminados o cancelados tras firmarse) sobre los que
            había al empezar el mes más las altas del mes. Las reservas online que no se llegaron a
            pagar no cuentan.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay datos suficientes todavía.</p>
          ) : (
            <>
              <div className="h-80">
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  initialDimension={{ width: 300, height: 256 }}
                >
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                    <YAxis unit=" %" tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => `${(Number(v) || 0).toLocaleString('es-ES')} %`} />
                    <Line type="monotone" dataKey="Bajas" stroke="#dc2626" strokeWidth={2} dot />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <ChartData
                headers={['Mes', 'Al empezar', 'Altas', 'Bajas', 'Tasa']}
                rows={months.map((m) => [
                  shortMonth(m.yearMonth),
                  m.activeAtStart,
                  m.started,
                  m.ended,
                  formatPct(m.churnRate),
                ])}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Por qué se van: lo que marcan en la encuesta de salida, en el periodo elegido. */
function ExitReasonsCard({ facilityId, period }: { facilityId?: string; period: Period }) {
  const reasons = useExitReasons({ from: period.from, to: period.to, facilityId });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Por qué se van</CardTitle>
        <CardDescription>
          Lo que responden en la encuesta de salida, que se envía sola a quien pide la baja.
          {reasons.data && reasons.data.sent > 0
            ? ` ${reasons.data.answered} de ${reasons.data.sent} respondidas${
                reasons.data.nps !== null
                  ? ` · recomendarían el negocio (de −100 a 100): ${reasons.data.nps}`
                  : ''
              }.`
            : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState query={reasons} height="h-24">
          {(d) =>
            d.reasons.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {d.sent === 0
                  ? 'No se ha enviado ninguna encuesta de salida en este periodo.'
                  : 'Aún no ha respondido nadie en este periodo.'}
              </p>
            ) : (
              <ul className="space-y-2.5">
                {d.reasons.map((r) => (
                  <li key={r.reason} className="text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span>{r.label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {r.count} · {r.pct} %
                      </span>
                    </div>
                    <div className="mt-1 h-2 rounded bg-muted">
                      <div
                        className="h-2 rounded"
                        style={{ width: `${Math.max(2, r.pct)}%`, backgroundColor: '#2a78d6' }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryState>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Deudas
// ============================================================================

const BUCKET_COLORS = ['#16a34a', '#eab308', '#f97316', '#dc2626'];
const BUCKET_LABELS: Record<string, string> = {
  '0-30': 'Menos de 30 días',
  '30-60': '30 a 60 días',
  '60-90': '60 a 90 días',
  '+90': 'Más de 90 días',
};

function AgingPanel({ facilityId, ownerId }: { facilityId?: string; ownerId?: string }) {
  const aging = useAging({ facilityId, ownerId });

  return (
    <QueryState query={aging}>
      {(d) => {
        const chartData = d.buckets.map((b, i) => ({
          range: BUCKET_LABELS[b.range] ?? b.range,
          Importe: Number(b.amount.toFixed(2)),
          color: BUCKET_COLORS[i % BUCKET_COLORS.length],
        }));
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <KpiCard title="Vencido sin cobrar" value={eur(d.totalOutstanding)}>
                Facturas vencidas sin cobrar (sin las fianzas).{' '}
                <Link href="/arrears" className="text-primary underline">
                  Ver quién debe
                </Link>
              </KpiCard>
              <KpiCard
                title="Facturas vencidas"
                value={String(d.buckets.reduce((acc, b) => acc + b.invoiceCount, 0))}
              >
                Repartidas por el tiempo que llevan vencidas
              </KpiCard>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Antigüedad de la deuda</CardTitle>
                <CardDescription>
                  Lo pendiente según los días que han pasado desde el vencimiento.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {d.totalOutstanding === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No hay deuda vencida. ¡Todo al día!
                  </p>
                ) : (
                  <>
                    <div className="h-80">
                      <ResponsiveContainer
                        width="100%"
                        height="100%"
                        initialDimension={{ width: 300, height: 256 }}
                      >
                        <BarChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="range" tick={{ fontSize: 11 }} />
                          <YAxis tickFormatter={(v) => compactEuros(Number(v) || 0)} />
                          <Tooltip formatter={(v) => eur(Number(v) || 0)} />
                          <Bar dataKey="Importe">
                            {chartData.map((entry, idx) => (
                              <Cell key={`cell-${idx}`} fill={entry.color} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <ChartData
                      headers={['Vencida hace', 'Facturas', 'Importe']}
                      rows={d.buckets.map((b) => [
                        BUCKET_LABELS[b.range] ?? b.range,
                        b.invoiceCount,
                        eur(b.amount),
                      ])}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}

// ============================================================================
// Contactos
// ============================================================================

function LeadsPanel({ facilityId, period }: { facilityId?: string; period: Period }) {
  const range = { ...periodDays(period), facilityId };
  const funnel = useLeadsFunnel(range);
  // El anterior hasta el mismo día: el mes en curso va a medias.
  const previous = useLeadsFunnel({ ...previousPeriodDays(period), facilityId });

  return (
    <QueryState query={funnel}>
      {(d) => {
        // Embudo acumulado: cuántos llegaron al menos a cada fase.
        const funnelData = [
          { stage: 'Recibidos', Contactos: d.total },
          { stage: 'Contactados', Contactos: d.reached.contacted },
          { stage: 'Cualificados', Contactos: d.reached.qualified },
          { stage: 'Ganados', Contactos: d.reached.won },
        ];
        const sourceData = d.bySource.map((s) => ({
          source: s.source ? leadSourceLabel(s.source) : 'Sin origen',
          Contactos: s.count,
        }));
        const suffix = 'vs periodo anterior hasta el mismo día';
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <KpiCard
                title={`Contactos recibidos (${periodText(period)})`}
                value={String(d.total)}
              >
                <Delta
                  current={d.total}
                  previous={previous.data?.total}
                  kind="count"
                  suffix={suffix}
                />
              </KpiCard>
              <KpiCard title="Ganados" value={String(d.reached.won)}>
                <Delta
                  current={d.reached.won}
                  previous={previous.data?.reached.won}
                  kind="count"
                  suffix={suffix}
                />
              </KpiCard>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <KpiCard title="Nuevo → Contactado" value={formatPct(d.conversion.newToContacted)}>
                A cuántos se les ha respondido
              </KpiCard>
              <KpiCard
                title="Contactado → Cualificado"
                value={formatPct(d.conversion.contactedToQualified)}
              >
                Cuántos tenían interés de verdad
              </KpiCard>
              <KpiCard title="Cualificado → Ganado" value={formatPct(d.conversion.qualifiedToWon)}>
                Cuántos acabaron contratando
              </KpiCard>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Embudo</CardTitle>
                <CardDescription>
                  {d.total} contactos recibidos del {formatDate(d.from)} al {formatDate(d.to)}:
                  cuántos llegaron a cada fase. Ahora mismo: {d.totals.new} nuevos,{' '}
                  {d.totals.contacted} contactados, {d.totals.qualified} cualificados,{' '}
                  {d.totals.won} ganados y {d.totals.lost} perdidos.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-80">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    initialDimension={{ width: 300, height: 256 }}
                  >
                    <BarChart data={funnelData} layout="vertical" margin={{ left: 24 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                      <YAxis dataKey="stage" type="category" width={96} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="Contactos" fill="#3b82f6" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <ChartData
                  headers={['Fase', 'Contactos']}
                  rows={funnelData.map((f) => [f.stage, f.Contactos])}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Por origen</CardTitle>
                <CardDescription>De dónde llegan los contactos.</CardDescription>
              </CardHeader>
              <CardContent>
                {sourceData.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No hay contactos en el periodo.</p>
                ) : (
                  <>
                    <div className="h-64">
                      <ResponsiveContainer
                        width="100%"
                        height="100%"
                        initialDimension={{ width: 300, height: 256 }}
                      >
                        <BarChart data={sourceData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="source" tick={{ fontSize: 11 }} />
                          <YAxis allowDecimals={false} />
                          <Tooltip />
                          <Bar dataKey="Contactos" fill="#8b5cf6" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <ChartData
                      headers={['Origen', 'Contactos']}
                      rows={sourceData.map((s) => [s.source, s.Contactos])}
                    />
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Por qué se pierden</CardTitle>
                <CardDescription>
                  Motivo de los contactos perdidos del periodo (se pide al pasarlos a «Perdidos»).
                </CardDescription>
              </CardHeader>
              <CardContent>
                {d.lostReasons.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No hay contactos perdidos en el periodo.
                  </p>
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
      }}
    </QueryState>
  );
}

function LeadsUtmCard({ range }: { range: { from: string; to: string; facilityId?: string } }) {
  const utm = useLeadsUtm(range);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Campañas</CardTitle>
          <CardDescription>
            Cuántos contactos trae cada campaña y cuántos acaban contratando. Cuenta los que llegan
            con un enlace marcado con su origen y campaña (los enlaces de Marketing → Canales ya lo
            llevan).
          </CardDescription>
        </div>
        <CsvButton
          disabled={!utm.data?.rows.length}
          filename="campanas.csv"
          rows={() => [
            ['Origen', 'Campaña', 'Contactos', 'Ganados', 'Conversión (%)'],
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
      <CardContent className="overflow-x-auto">
        <QueryState query={utm} height="h-24">
          {(data) =>
            data.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aún no hay contactos que lleguen con una campaña. Usa los enlaces de Marketing →
                Canales o añade al enlace, por ejemplo,{' '}
                <code className="text-xs">?utm_source=google&utm_campaign=verano</code>.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Origen</TableHead>
                    <TableHead>Campaña</TableHead>
                    <TableHead className="text-right">Contactos</TableHead>
                    <TableHead className="text-right">Ganados</TableHead>
                    <TableHead className="text-right">Conversión</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={`${r.source}|${r.campaign}`}>
                      <TableCell className="font-medium">{r.source}</TableCell>
                      <TableCell>{r.campaign}</TableCell>
                      <TableCell className="text-right">{r.total}</TableCell>
                      <TableCell className="text-right">{r.won}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatPct(r.conversionRate)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </QueryState>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Riesgo de baja
// ============================================================================

const RISK_BADGE: Record<ChurnRiskLevel, { label: string; className: string }> = {
  high: {
    label: 'Alto',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 hover:bg-red-100',
  },
  medium: {
    label: 'Medio',
    className:
      'bg-amber-100 text-amber-700 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-950',
  },
  low: {
    label: 'Bajo',
    className:
      'bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-950',
  },
};

function ChurnRiskPanel({ facilityId }: { facilityId?: string }) {
  const risk = useChurnRisk(facilityId);

  return (
    <QueryState query={risk}>
      {(d) => {
        const showFee = d.items.some((i) => i.priceMonthly !== null);
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <KpiCard title="Riesgo alto" value={String(d.summary.high)}>
                Inquilinos con los que conviene hablar ya
              </KpiCard>
              <KpiCard title="Riesgo medio" value={String(d.summary.medium)}>
                Vigilar de cerca
              </KpiCard>
              <KpiCard title="Inquilinos con contrato" value={String(d.summary.total)}>
                Analizados en total
              </KpiCard>
            </div>

            <Card>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
                <div className="space-y-1.5">
                  <CardTitle className="text-base">Inquilinos en riesgo</CardTitle>
                  <CardDescription>
                    Puntuación de 0 a 100 por inquilino (con todos sus trasteros) según facturas
                    vencidas, cobros fallidos y reclamaciones (lo de los últimos 90 días pesa más),
                    un contrato que vence sin renovación, no tener cómo pagar solo (si tu negocio
                    cobra con tarjeta o domiciliación) y no entrar al local en 90 días (si tienes
                    puertas conectadas).
                  </CardDescription>
                </div>
                <CsvButton
                  disabled={d.items.length === 0}
                  filename="riesgo-de-baja.csv"
                  rows={() => [
                    [
                      'Inquilino',
                      'Trasteros',
                      'Local',
                      ...(showFee ? ['Cuota al mes'] : []),
                      'Puntuación',
                      'Último acceso',
                      'Señales',
                    ],
                    ...d.items.map((i) => [
                      i.customerName,
                      i.unitCode,
                      i.facilityName,
                      ...(showFee ? [i.priceMonthly ?? ''] : []),
                      i.score,
                      i.lastAccessAt ? formatDate(i.lastAccessAt) : '',
                      i.factors.join(' · '),
                    ]),
                  ]}
                />
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {d.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No hay inquilinos con señales de riesgo. ¡Buena retención!
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Inquilino</TableHead>
                        <TableHead>Trasteros</TableHead>
                        {showFee && <TableHead className="text-right">Cuota al mes</TableHead>}
                        <TableHead>Riesgo</TableHead>
                        <TableHead>Señales</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.items.map((item) => (
                        <TableRow key={item.customerId}>
                          <TableCell className="font-medium">
                            <Link
                              href={`/customers/${item.customerId}`}
                              className="hover:underline"
                            >
                              {item.customerName}
                            </Link>
                          </TableCell>
                          <TableCell>
                            {item.unitCode}
                            <span className="block text-xs text-muted-foreground">
                              {item.facilityName}
                            </span>
                          </TableCell>
                          {showFee && (
                            <TableCell className="text-right">
                              {item.priceMonthly === null ? '—' : eur(item.priceMonthly)}
                            </TableCell>
                          )}
                          <TableCell>
                            <Badge
                              className={`whitespace-nowrap ${RISK_BADGE[item.level].className}`}
                              variant="secondary"
                            >
                              {RISK_BADGE[item.level].label} · {item.score}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {item.factors.join(' · ')}
                            {item.lastAccessAt && (
                              <span className="block">
                                Último acceso: {formatDate(item.lastAccessAt)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button asChild size="sm" variant="outline">
                              {item.contractStatus === 'ending' ? (
                                <Link href={`/contracts/${item.contractId}`}>
                                  Ofrecer retención
                                </Link>
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
      }}
    </QueryState>
  );
}

// ============================================================================
// Precio por tipo
// ============================================================================

const PRICING_BADGE: Record<PricingAction, { label: string; className: string }> = {
  raise: {
    label: 'Subir',
    className:
      'bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-950',
  },
  lower: {
    label: 'Bajar',
    className:
      'bg-amber-100 text-amber-700 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-950',
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
  // El precio de un tipo vale para todos los locales: solo quien los ve todos.
  const canManage = useHasPermission('units:manage');
  const companyWide = useCompanyWide();
  const canApply = canManage && companyWide;

  async function applySuggestion(
    unitTypeId: string,
    name: string,
    price: number,
    freeUnits: number,
  ) {
    const units =
      freeUnits === 0
        ? 'Ahora no hay ningún trastero libre de este tipo.'
        : freeUnits === 1
          ? 'También cambia el precio del trastero libre de este tipo.'
          : `También cambia el precio de los ${freeUnits} trasteros libres de este tipo.`;
    if (
      !(await ask({
        title: `¿Poner «${name}» a ${eur(price)} al mes?`,
        description: `Es el precio sin IVA para quien lo alquile a partir de ahora, en todos los locales${
          facilityId ? ' (no solo en el que estás mirando)' : ''
        }. ${units} Los contratos en vigor no cambian: para subir a quien ya tienes, usa las subidas de precio.`,
      }))
    )
      return;
    try {
      const res = await apply.mutateAsync({ unitTypeId, price });
      toast.success(
        res.unitsUpdated > 0
          ? `Precio actualizado (y en ${res.unitsUpdated} ${res.unitsUpdated === 1 ? 'trastero libre' : 'trasteros libres'}).`
          : 'Precio actualizado.',
      );
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
            lista de espera). Precios sin IVA. Aplicar cambia el precio del tipo y el de sus
            trasteros libres en todos los locales; los contratos en vigor no cambian — para subir a
            quien ya tienes usa <em>Subidas de precio</em>.
            {canManage && !companyWide && (
              <span className="mt-1 block">
                Solo puede aplicarlo quien ve todos los locales: afecta a todos.
              </span>
            )}
          </CardDescription>
        </div>
        <CsvButton
          disabled={!pricing.data?.items.length}
          filename="precios-por-tipo.csv"
          rows={() => [
            ['Tipo', 'Ocupación (%)', 'Mercado', 'Precio actual', 'Sugerido'],
            ...(pricing.data?.items ?? []).map((i) => [
              i.unitTypeName,
              Math.round(i.occupancy),
              i.marketPrice ?? '',
              i.currentPrice,
              i.suggestedPrice,
            ]),
          ]}
        />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <QueryState query={pricing}>
          {(data) =>
            data.items.length === 0 ? (
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
                  {data.items.map((item) => (
                    <TableRow key={item.unitTypeId}>
                      <TableCell className="font-medium">
                        {item.unitTypeName}
                        <span className="block text-xs text-muted-foreground">
                          {item.occupiedUnits} de {item.totalUnits} ocupados
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {formatPct(item.occupancy / 100, 0)}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.marketPrice != null ? eur(item.marketPrice) : '—'}
                        {item.marketTrend && <TrendNote trend={item.marketTrend} />}
                        <span
                          className="block text-xs text-muted-foreground"
                          title={CONFIDENCE[item.confidence].title}
                        >
                          {CONFIDENCE[item.confidence].label}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">{eur(item.currentPrice)}</TableCell>
                      <TableCell className="text-right font-medium">
                        {eur(item.suggestedPrice)}
                        {item.changePct !== 0 && (
                          <span
                            className={`ml-1 text-xs ${
                              item.changePct > 0 ? 'text-emerald-600' : 'text-amber-600'
                            }`}
                          >
                            ({item.changePct > 0 ? '+' : ''}
                            {item.changePct.toLocaleString('es-ES')} %)
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={PRICING_BADGE[item.action].className} variant="secondary">
                          {PRICING_BADGE[item.action].label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.rationale}
                      </TableCell>
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
                                item.availableUnitsAll,
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
            )
          }
        </QueryState>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Previsión
// ============================================================================

function ForecastPanel({ facilityId }: { facilityId?: string }) {
  const forecast = useRevenueForecast({ months: 6, facilityId });

  return (
    <QueryState query={forecast}>
      {(d) => {
        const money = d.current.mrr !== null;
        const chartData = [
          {
            mes: 'Hoy',
            'Cuotas al mes': d.current.mrr ?? 0,
            Ocupación: Math.round(d.current.occupancy * 1000) / 10,
          },
          ...d.points.map((p) => ({
            mes: shortMonth(p.yearMonth),
            'Cuotas al mes': p.projectedMrr ?? 0,
            Ocupación: Math.round(p.projectedOccupancy * 1000) / 10,
          })),
        ];
        const lastPoint = d.points[d.points.length - 1];
        const history = d.assumptions.historyMonths;
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                title={money ? 'Cuotas al mes hoy' : 'Contratos hoy'}
                value={money ? eur(d.current.mrr ?? 0) : String(d.current.activeContracts)}
              >
                {d.current.activeContracts} contratos activos
              </KpiCard>
              <KpiCard
                title={`Dentro de ${d.points.length} meses`}
                value={
                  lastPoint
                    ? money
                      ? eur(lastPoint.projectedMrr ?? 0)
                      : String(lastPoint.projectedActiveContracts)
                    : '—'
                }
              >
                {lastPoint ? `${lastPoint.projectedActiveContracts} contratos previstos` : '—'}
              </KpiCard>
              <KpiCard
                title="Tasa de bajas media al mes"
                value={formatPct(d.assumptions.monthlyChurnRate, 2)}
              >
                Media de{' '}
                {history === 1 ? 'el último mes cerrado' : `los últimos ${history} meses cerrados`}
              </KpiCard>
              <KpiCard
                title="Altas al mes (media)"
                value={d.assumptions.avgMonthlyNewContracts.toLocaleString('es-ES', {
                  maximumFractionDigits: 1,
                })}
              >
                {d.assumptions.avgContractValue !== null
                  ? `Cada contrato paga de media ${eur(d.assumptions.avgContractValue)} al mes`
                  : 'Contratos nuevos de media cada mes'}
              </KpiCard>
            </div>

            {d.assumptions.cappedAtCapacity && (
              <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                A este ritmo te quedas sin trasteros libres: la previsión se para en los{' '}
                {d.current.totalUnits} que se pueden alquilar.
              </p>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Previsión a {d.points.length} meses</CardTitle>
                <CardDescription>
                  Estimación con la tendencia de los meses cerrados (bajas y altas medias). No es
                  una garantía: cuanto más histórico, más fiable.
                  {history < d.assumptions.trailingMonths &&
                    ` Tu negocio lleva ${history} ${history === 1 ? 'mes' : 'meses'} con contratos: las medias son de ese tiempo.`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-80">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    initialDimension={{ width: 300, height: 256 }}
                  >
                    <AreaChart data={chartData} margin={{ left: 8, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                      {money && (
                        <YAxis yAxisId="mrr" tickFormatter={(v) => compactEuros(Number(v) || 0)} />
                      )}
                      <YAxis yAxisId="occ" orientation="right" unit=" %" domain={[0, 100]} />
                      <Tooltip
                        formatter={(value, name) =>
                          name === 'Cuotas al mes'
                            ? eur(Number(value) || 0)
                            : `${(Number(value) || 0).toLocaleString('es-ES')} %`
                        }
                      />
                      <Legend />
                      {money && (
                        <Area
                          yAxisId="mrr"
                          type="monotone"
                          dataKey="Cuotas al mes"
                          stroke="#2563eb"
                          fill="#2563eb"
                          fillOpacity={0.15}
                          strokeWidth={2}
                        />
                      )}
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
                </div>
                <ChartData
                  headers={['Mes', 'Contratos', 'Ocupación', ...(money ? ['Cuotas al mes'] : [])]}
                  rows={d.points.map((p) => [
                    shortMonth(p.yearMonth),
                    p.projectedActiveContracts,
                    formatPct(p.projectedOccupancy, 0),
                    ...(money ? [eur(p.projectedMrr ?? 0)] : []),
                  ])}
                />
              </CardContent>
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}

// ============================================================================
// Comparativa del sector
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
  // Posición de «tú» y de la mediana en la barra (del 25 % más bajo al 25 % más alto).
  const span = metric.p75 - metric.p25;
  const pos = (value: number) =>
    span <= 0 ? 50 : Math.max(0, Math.min(100, ((value - metric.p25) / span) * 100));
  const minePos = pos(metric.mine);
  const medianPos = pos(metric.median);
  const aboveMedian = metric.mine >= metric.median;

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Badge variant={aboveMedian ? 'default' : 'secondary'}>
          Por encima del {metric.myPercentile} % de los operadores
        </Badge>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span>
          Tú: <span className="font-semibold">{format(metric.mine)}</span>
        </span>
        <span className="text-muted-foreground">
          Lo normal en el sector: {format(metric.median)}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-muted" aria-hidden>
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-400"
          style={{ left: `${medianPos}%` }}
          title={`Lo normal: ${format(metric.median)}`}
        />
        <div
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow"
          style={{ left: `${minePos}%` }}
          title={`Tú: ${format(metric.mine)}`}
        />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Uno de cada cuatro, menos de {format(metric.p25)}</span>
        <span>Uno de cada cuatro, más de {format(metric.p75)}</span>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function BenchmarkPanel() {
  const benchmark = useBenchmark();

  return (
    <QueryState query={benchmark}>
      {(d) =>
        !d.available ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Comparativa del sector</CardTitle>
              <CardDescription>
                Compara tu ocupación y tus precios con los de otros negocios de trasteros.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Aún no hay datos suficientes para comparar: hacen falta al menos 10 negocios con
                contratos, para que nadie pueda reconocer los datos de otro. Se activará sola cuando
                los haya.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Comparativa del sector</CardTitle>
              <CardDescription>
                Tu posición frente a {d.sampleSize} negocios de trasteros. Son datos de conjunto y
                anónimos: nunca se enseña lo de un negocio concreto. Precios sin IVA.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {d.occupancy && (
                <BenchmarkMetricRow
                  label="Ocupación"
                  metric={d.occupancy}
                  format={(v) => formatPct(v / 100)}
                  hint="Trasteros ocupados sobre los que se pueden alquilar."
                />
              )}
              {d.price && (
                <BenchmarkMetricRow
                  label="Precio medio por trastero"
                  metric={d.price}
                  format={eur}
                  hint="Cuota de catálogo al mes, de media."
                />
              )}
              {d.pricePerSqm && (
                <BenchmarkMetricRow
                  label="Precio por m²"
                  metric={d.pricePerSqm}
                  format={(v) => `${eur(v)}/m²`}
                  hint="Cuota al mes por metro cuadrado, de media."
                />
              )}
            </CardContent>
          </Card>
        )
      }
    </QueryState>
  );
}

// ============================================================================
// SEO
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
      {done} de {total}
    </Badge>
  );
}

function ChecklistRow({ item }: { item: SeoChecklistItemDto }) {
  return (
    <div className="flex items-start gap-3 border-b py-3 last:border-0">
      {item.done ? (
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-label="Hecho" />
      ) : (
        <CircleDashed
          className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          aria-label="Pendiente"
        />
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

  return (
    <QueryState query={checklist}>
      {(d) => (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-normal text-muted-foreground">
                  Lo básico
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
              <CardTitle className="text-base">Lo básico</CardTitle>
              <CardDescription>
                Datos de tus locales que Google usa para enseñarte en las búsquedas de tu zona.
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
              <CardTitle className="text-base">Con Web Premium</CardTitle>
              <CardDescription>
                Textos propios, preguntas frecuentes, opiniones, formulario de contacto y blog.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!d.hasWebPremium ? (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  Activa <strong>Web Premium</strong> para tener plantillas de diseño, textos
                  propios, preguntas frecuentes, opiniones, formulario de contacto y blog: lo que
                  más ayuda a aparecer en Google con el tiempo.{' '}
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
      )}
    </QueryState>
  );
}

/** Eje de importes: «850 €», «12,5 mil €». */
function compactEuros(v: number): string {
  if (Math.abs(v) < 1000) return `${Math.round(v)} €`;
  return `${(v / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} mil €`;
}

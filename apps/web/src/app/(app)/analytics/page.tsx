'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
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

import type { ChurnRiskLevel, PricingAction } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
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
  useChurn,
  useChurnRisk,
  useLeadsFunnel,
  useLeadsUtm,
  useMonthlyRevenue,
  useOccupancy,
  usePricingSuggestions,
  useRevenueForecast,
} from '@/lib/analytics/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

export default function AnalyticsPage() {
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analítica</h1>
        <p className="text-sm text-muted-foreground">
          KPIs clave del negocio: ocupación, churn, morosidad, leads e insights (riesgo de baja y
          precio dinámico).
        </p>
      </div>

      <Tabs defaultValue="revenue" className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="revenue">Ingresos</TabsTrigger>
          <TabsTrigger value="occupancy">Ocupación</TabsTrigger>
          <TabsTrigger value="churn">Churn</TabsTrigger>
          <TabsTrigger value="aging">Morosidad</TabsTrigger>
          <TabsTrigger value="leads">Leads</TabsTrigger>
          <TabsTrigger value="churn-risk">Riesgo de baja</TabsTrigger>
          <TabsTrigger value="pricing">Precio dinámico</TabsTrigger>
          <TabsTrigger value="forecast">Previsión</TabsTrigger>
        </TabsList>
        <TabsContent value="revenue" className="mt-4">
          <MonthlyRevenuePanel />
        </TabsContent>
        <TabsContent value="occupancy" className="mt-4">
          <OccupancyPanel />
        </TabsContent>
        <TabsContent value="churn" className="mt-4">
          <ChurnPanel />
        </TabsContent>
        <TabsContent value="aging" className="mt-4">
          <AgingPanel />
        </TabsContent>
        <TabsContent value="leads" className="mt-4">
          <LeadsPanel />
        </TabsContent>
        <TabsContent value="churn-risk" className="mt-4">
          <ChurnRiskPanel />
        </TabsContent>
        <TabsContent value="pricing" className="mt-4">
          <PricingSuggestionsPanel />
        </TabsContent>
        <TabsContent value="forecast" className="mt-4">
          <ForecastPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================================
// Ocupación
// ============================================================================

function OccupancyPanel() {
  const occupancy = useOccupancy();

  if (occupancy.isLoading || !occupancy.data) {
    return <PanelLoader />;
  }

  const d = occupancy.data;
  const chartData = d.perFacility.map((f) => ({
    name: f.facilityName,
    Ocupados: f.occupied,
    Disponibles: Math.max(0, f.total - f.occupied),
  }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="Ocupación física" value={formatPercent(d.physicalOccupancy)}>
          {d.occupiedUnits} de {d.totalUnits} trasteros
        </KpiCard>
        <KpiCard title="Ocupación económica" value={formatPercent(d.economicOccupancy)}>
          MRR real vs MRR potencial
        </KpiCard>
        <KpiCard title="MRR actual" value={formatCurrency(d.mrrActual)}>
          Suma de cuotas mensuales activas
        </KpiCard>
        <KpiCard title="MRR potencial" value={formatCurrency(d.mrrPotential)}>
          Si todos los trasteros estuvieran alquilados
        </KpiCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ocupación por local</CardTitle>
          <CardDescription>
            Comparación de trasteros ocupados vs. disponibles en cada local.
          </CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay locales todavía.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis dataKey="name" type="category" width={120} />
                <Tooltip />
                <Bar dataKey="Ocupados" stackId="a" fill="#16a34a" />
                <Bar dataKey="Disponibles" stackId="a" fill="#94a3b8" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// Churn
// ============================================================================

function ChurnPanel() {
  const churn = useChurn();

  if (churn.isLoading || !churn.data) {
    return <PanelLoader />;
  }

  const months = churn.data.months;
  const chartData = months.map((m) => ({
    month: m.yearMonth,
    Churn: Number((m.churnRate * 100).toFixed(2)),
  }));

  const last = months[months.length - 1];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          title="Churn último mes"
          value={last ? `${(last.churnRate * 100).toFixed(2)}%` : '—'}
        >
          {last ? `${last.ended} de ${last.activeAtStart} activos al inicio` : '—'}
        </KpiCard>
        <KpiCard
          title="Contratos cerrados"
          value={String(months.reduce((acc, m) => acc + m.ended, 0))}
        >
          Suma del periodo
        </KpiCard>
        <KpiCard title="Meses analizados" value={String(months.length)}>
          Por defecto, últimos 12 meses
        </KpiCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evolución del churn</CardTitle>
          <CardDescription>
            Porcentaje de contratos finalizados sobre los activos a inicio de cada mes.
          </CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay datos suficientes todavía.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
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

function AgingPanel() {
  const aging = useAging();

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
          Suma de facturas no cobradas (emitidas / vencidas)
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
            <ResponsiveContainer width="100%" height="100%">
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

function LeadsPanel() {
  const funnel = useLeadsFunnel();

  if (funnel.isLoading || !funnel.data) {
    return <PanelLoader />;
  }

  const d = funnel.data;
  const funnelData = [
    { stage: 'Nuevos', count: d.totals.new },
    { stage: 'Contactados', count: d.totals.contacted },
    { stage: 'Cualificados', count: d.totals.qualified },
    { stage: 'Ganados', count: d.totals.won },
    { stage: 'Perdidos', count: d.totals.lost },
  ];
  const sourceData = d.bySource.map((s) => ({
    source: s.source || '(sin origen)',
    count: s.count,
  }));

  return (
    <div className="space-y-4">
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
          <CardTitle className="text-base">Funnel</CardTitle>
          <CardDescription>Volumen de leads en cada fase del periodo.</CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={funnelData} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" />
              <YAxis dataKey="stage" type="category" width={110} />
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
            <ResponsiveContainer width="100%" height="100%">
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

      <LeadsUtmCard />
    </div>
  );
}

function LeadsUtmCard() {
  const utm = useLeadsUtm();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Campañas (UTM)</CardTitle>
        <CardDescription>
          Conversión por origen y campaña de los leads que llegan con parámetros{' '}
          <code className="text-xs">utm_*</code> en la URL (widget / booking).
        </CardDescription>
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
  high: { label: 'Alto', className: 'bg-red-100 text-red-700 hover:bg-red-100' },
  medium: { label: 'Medio', className: 'bg-amber-100 text-amber-700 hover:bg-amber-100' },
  low: { label: 'Bajo', className: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' },
};

function ChurnRiskPanel() {
  const risk = useChurnRisk();

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
        <CardHeader>
          <CardTitle className="text-base">Contratos en riesgo</CardTitle>
          <CardDescription>
            Puntuación heurística (0-100) basada en impagos, cobros fallidos, reclamaciones,
            vencimiento sin renovación y ausencia de método de pago.
          </CardDescription>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.items.map((item) => (
                  <TableRow key={item.contractId}>
                    <TableCell className="font-medium">{item.contractNumber}</TableCell>
                    <TableCell>{item.customerName}</TableCell>
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
  raise: { label: 'Subir', className: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' },
  lower: { label: 'Bajar', className: 'bg-amber-100 text-amber-700 hover:bg-amber-100' },
  hold: { label: 'Mantener', className: 'bg-slate-100 text-slate-600 hover:bg-slate-100' },
};

function PricingSuggestionsPanel() {
  const pricing = usePricingSuggestions();
  const apply = useApplyPricing();
  const canApply = useHasPermission('units:manage');

  if (pricing.isLoading || !pricing.data) {
    return <PanelLoader />;
  }

  const items = pricing.data.items;

  async function applySuggestion(unitTypeId: string, name: string, price: number) {
    if (
      !window.confirm(
        `¿Fijar el precio de catálogo de "${name}" en ${formatCurrency(price)}? Afecta a los nuevos contratos; los activos no cambian.`,
      )
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
      <CardHeader>
        <CardTitle className="text-base">Sugerencias de precio</CardTitle>
        <CardDescription>
          Recomendaciones de yield management según la ocupación de cada tipo de trastero. Aplicar
          fija el <strong>precio de catálogo</strong> del tipo (nuevos contratos); los contratos
          activos no cambian — para subir la cartera usa <em>Subidas de precio</em> (ECRI).
        </CardDescription>
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

function ForecastPanel() {
  const forecast = useRevenueForecast({ months: 6 });

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
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ left: 8, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" />
              <YAxis yAxisId="mrr" tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
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

function PanelLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Mes/año actuales y helpers para los atajos de rango (formato YYYY-MM). */
function ym(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

interface RevenueRange {
  key: string;
  label: string;
  months?: number;
  from?: string;
  to?: string;
}

function buildPresets(): RevenueRange[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const qStart = Math.floor((m - 1) / 3) * 3 + 1;
  return [
    { key: 'm12', label: 'Últimos 12 meses', months: 12 },
    { key: 'm6', label: 'Últimos 6 meses', months: 6 },
    { key: 'thisYear', label: 'Este año', from: ym(y, 1), to: ym(y, m) },
    { key: 'lastYear', label: 'Año pasado', from: ym(y - 1, 1), to: ym(y - 1, 12) },
    { key: 'thisQuarter', label: 'Este trimestre', from: ym(y, qStart), to: ym(y, m) },
  ];
}

const MONTHS_ES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

/** Selector de mes + año (desplegables nativos del proyecto, fiables en todos
 * los navegadores). `value` en formato YYYY-MM; emite YYYY-MM al cambiar. */
function MonthYearSelect({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const now = new Date();
  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);
  const parsed = value ? value.split('-').map(Number) : null;
  const curMonth = parsed?.[1];
  const curYear = parsed?.[0];
  const baseYear = curYear ?? now.getFullYear();
  const baseMonth = curMonth ?? now.getMonth() + 1;
  return (
    <div className="flex gap-1.5">
      <Select
        value={curMonth ? String(curMonth) : undefined}
        onValueChange={(v) => onChange(ym(baseYear, Number(v)))}
      >
        <SelectTrigger className="h-9 w-[130px]">
          <SelectValue placeholder="Mes" />
        </SelectTrigger>
        <SelectContent>
          {MONTHS_ES.map((label, i) => (
            <SelectItem key={i} value={String(i + 1)}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={curYear ? String(curYear) : undefined}
        onValueChange={(v) => onChange(ym(Number(v), baseMonth))}
      >
        <SelectTrigger className="h-9 w-[90px]">
          <SelectValue placeholder="Año" />
        </SelectTrigger>
        <SelectContent>
          {years.map((y) => (
            <SelectItem key={y} value={String(y)}>
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function MonthlyRevenuePanel() {
  const presets = buildPresets();
  const [sel, setSel] = useState<RevenueRange>(presets[0]!);

  const query = sel.from && sel.to ? { from: sel.from, to: sel.to } : { months: sel.months ?? 12 };
  const revenue = useMonthlyRevenue(query);

  const isRange = !!(sel.from && sel.to);

  function setCustom(part: 'from' | 'to', value: string) {
    // Conserva el otro extremo; la consulta solo pasa a rango cuando ambos
    // están definidos (mientras tanto sigue mostrando los últimos 12 meses).
    setSel({
      key: 'custom',
      label: 'Personalizado',
      from: part === 'from' ? value || undefined : sel.from,
      to: part === 'to' ? value || undefined : sel.to,
    });
  }

  const controls = (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <Button
            key={p.key}
            size="sm"
            variant={sel.key === p.key ? 'default' : 'outline'}
            onClick={() => setSel(p)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="space-y-1">
          <Label className="text-xs">Desde</Label>
          <MonthYearSelect value={sel.from} onChange={(v) => setCustom('from', v)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Hasta</Label>
          <MonthYearSelect value={sel.to} onChange={(v) => setCustom('to', v)} />
        </div>
      </div>
    </div>
  );

  if (revenue.isLoading || !revenue.data) {
    return (
      <div className="space-y-4">
        {controls}
        <PanelLoader />
      </div>
    );
  }

  const points = revenue.data.points;
  const totalInvoiced = points.reduce((acc, p) => acc + p.invoiced, 0);
  const totalCollected = points.reduce((acc, p) => acc + p.collected, 0);
  const chartData = points.map((p) => ({
    mes: p.label,
    Facturado: p.invoiced,
    Cobrado: p.collected,
  }));
  const periodLabel = isRange
    ? `${points[0]?.label ?? ''} – ${points[points.length - 1]?.label ?? ''}`
    : sel.label.toLowerCase();

  return (
    <div className="space-y-4">
      {controls}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <KpiCard title={`Facturado (${periodLabel})`} value={formatCurrency(totalInvoiced)}>
          Facturas emitidas en el periodo
        </KpiCard>
        <KpiCard title={`Cobrado (${periodLabel})`} value={formatCurrency(totalCollected)}>
          Pagos con éxito en el periodo
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
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="mes" />
                <YAxis />
                <Tooltip formatter={(v) => formatCurrency(Number(v) || 0)} />
                <Legend />
                <Bar dataKey="Facturado" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Cobrado" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Detalle mensual</CardTitle>
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

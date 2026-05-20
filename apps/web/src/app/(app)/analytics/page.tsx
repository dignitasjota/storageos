'use client';

import { Loader2 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAging, useChurn, useLeadsFunnel, useOccupancy } from '@/lib/analytics/hooks';

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

export default function AnalyticsPage() {
  return (
    <div className="space-y-4 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analítica</h1>
        <p className="text-sm text-muted-foreground">
          KPIs clave del negocio: ocupación, churn, morosidad y funnel de leads.
        </p>
      </div>

      <Tabs defaultValue="occupancy" className="w-full">
        <TabsList>
          <TabsTrigger value="occupancy">Ocupación</TabsTrigger>
          <TabsTrigger value="churn">Churn</TabsTrigger>
          <TabsTrigger value="aging">Morosidad</TabsTrigger>
          <TabsTrigger value="leads">Leads</TabsTrigger>
        </TabsList>
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

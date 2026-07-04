'use client';

import { Download, Loader2 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { ChurnByReasonCard } from './churn-by-reason-card';
import { MrrForecastCard } from './mrr-forecast-card';
import { MrrMovementsCard } from './mrr-movements-card';
import { PaymentRetriesCard } from './payment-retries-card';
import { RetentionCohortsCard } from './retention-cohorts-card';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminMetrics } from '@/lib/admin/hooks';
import { downloadCsv } from '@/lib/csv';

const STATUS_META: {
  key: 'active' | 'trial' | 'suspended' | 'cancelled';
  label: string;
  color: string;
}[] = [
  { key: 'active', label: 'Activos', color: '#16a34a' },
  { key: 'trial', label: 'Trial', color: '#eab308' },
  { key: 'suspended', label: 'Suspendidos', color: '#f97316' },
  { key: 'cancelled', label: 'Cancelados', color: '#94a3b8' },
];

const PLAN_COLORS = ['#2563eb', '#16a34a', '#a855f7', '#f97316', '#06b6d4', '#eab308', '#ec4899'];

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const eurShort = (n: number) =>
  n >= 1000 ? `${Math.round(n / 100) / 10}k €` : `${Math.round(n)} €`;

export default function AdminMetricsPage() {
  const metrics = useAdminMetrics();

  if (metrics.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!metrics.data) {
    return (
      <div className="px-4 py-4 sm:px-6 sm:py-6 text-sm text-muted-foreground">
        No hemos podido cargar las métricas.
      </div>
    );
  }

  const m = metrics.data;

  const statusPie = STATUS_META.map((s) => ({
    label: s.label,
    color: s.color,
    value: m.tenants[s.key],
  })).filter((d) => d.value > 0);

  const planPie = m.tenantsByPlan
    .filter((p) => p.count > 0)
    .map((p, i) => ({
      label: p.planName || p.planSlug,
      value: p.count,
      mrr: p.mrr,
      color: PLAN_COLORS[i % PLAN_COLORS.length] ?? '#94a3b8',
    }));

  function exportCsv() {
    const byLabel = new Map<
      string,
      { signups: number; cancellations: number; collected: number }
    >();
    for (const g of m.monthlyGrowth) {
      byLabel.set(g.label, { signups: g.signups, cancellations: g.cancellations, collected: 0 });
    }
    for (const r of m.monthlySaasRevenue) {
      const e = byLabel.get(r.label) ?? { signups: 0, cancellations: 0, collected: 0 };
      e.collected = r.collected;
      byLabel.set(r.label, e);
    }
    const rows: (string | number)[][] = [['Mes', 'Altas', 'Bajas', 'Cobrado (EUR)']];
    for (const [label, v] of byLabel) rows.push([label, v.signups, v.cancellations, v.collected]);
    downloadCsv('metricas-mensuales.csv', rows);
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Métricas</h1>
          <p className="text-sm text-muted-foreground">
            Vista global de la plataforma. Datos en tiempo real.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv}>
          <Download className="mr-1 size-4" /> Exportar CSV
        </Button>
      </div>

      {/* Tenants por estado */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Tenants</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
          <MetricCard label="Total" value={m.tenants.total} />
          <MetricCard label="Activos" value={m.tenants.active} />
          <MetricCard label="Trial" value={m.tenants.trial} />
          <MetricCard label="Suspendidos" value={m.tenants.suspended} />
          <MetricCard label="Cancelados" value={m.tenants.cancelled} />
        </div>
      </section>

      {/* Negocio */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Negocio</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <MetricCard label="MRR" value={eur(m.mrr.total)} />
          <MetricCard label="Ingreso medio / tenant" value={eur(m.averageRevenuePerTenant)} />
          <MetricCard label="Altas este mes" value={m.signupsThisMonth} />
          <MetricCard
            label="Churn (mes)"
            value={`${m.churnRatePercent.toFixed(1)}%`}
            hint={`${m.cancellationsThisMonth} bajas`}
          />
          <MetricCard
            label="Trials por expirar"
            value={m.trialsExpiringSoon}
            hint="próx. 7 días"
            accent={m.trialsExpiringSoon > 0 ? 'amber' : undefined}
          />
          <MetricCard
            label="Tickets abiertos"
            value={m.openSupportTickets}
            accent={m.openSupportTickets > 0 ? 'amber' : undefined}
          />
        </div>
      </section>

      {/* Distribuciones (tarta) */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Distribución</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Tenants por estado</CardTitle>
            </CardHeader>
            <CardContent>
              <DonutChart data={statusPie} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Tenants por plan</CardTitle>
            </CardHeader>
            <CardContent>
              <DonutChart data={planPie} subtitle={(d) => (d.mrr ? eurShort(d.mrr) : undefined)} />
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Series mensuales (barras) */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Evolución (12 meses)</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Altas vs bajas de tenants</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={m.monthlyGrowth}
                    margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={28}
                    />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 13 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="signups" name="Altas" fill="#16a34a" radius={[3, 3, 0, 0]} />
                    <Bar
                      dataKey="cancellations"
                      name="Bajas"
                      fill="#ef4444"
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Ingresos de suscripción cobrados</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={m.monthlySaasRevenue}
                    margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tickFormatter={eurShort}
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={52}
                    />
                    <Tooltip
                      formatter={(v) => eur(Number(v) || 0)}
                      contentStyle={{ borderRadius: 8, fontSize: 13 }}
                    />
                    <Bar dataKey="collected" name="Cobrado" fill="#2563eb" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* MRR movements + previsión */}
      <section>
        <MrrMovementsCard />
      </section>
      <section>
        <MrrForecastCard />
      </section>

      {/* Cohortes de retención + churn por razón */}
      <section className="grid gap-4 lg:grid-cols-2">
        <RetentionCohortsCard />
        <ChurnByReasonCard />
      </section>

      {/* Recuperación de cobros (retry analysis) */}
      <section className="grid gap-4 lg:grid-cols-2">
        <PaymentRetriesCard />
      </section>

      {/* Totales de plataforma */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">
          Plataforma (todos los tenants)
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
          <MetricCard label="Locales" value={m.platform.facilities} />
          <MetricCard label="Trasteros" value={m.platform.units} />
          <MetricCard label="Inquilinos" value={m.platform.customers} />
          <MetricCard label="Contratos" value={m.platform.contracts} />
          <MetricCard label="Usuarios" value={m.platform.users} />
        </div>
      </section>
    </div>
  );
}

type DonutDatum = { label: string; value: number; color: string; mrr?: number };

function DonutChart({
  data,
  subtitle,
}: {
  data: DonutDatum[];
  subtitle?: (d: DonutDatum) => string | undefined;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Sin datos.</p>;
  }
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row">
      <div className="h-44 w-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              innerRadius={46}
              outerRadius={78}
              paddingAngle={2}
              dataKey="value"
              nameKey="label"
            >
              {data.map((d) => (
                <Cell key={d.label} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v, n) => [String(v), n]}
              contentStyle={{ borderRadius: 8, fontSize: 13 }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="w-full space-y-1.5 text-sm">
        {data.map((d) => {
          const sub = subtitle?.(d);
          return (
            <li key={d.label} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span
                  className="inline-block size-2.5 rounded-sm"
                  style={{ backgroundColor: d.color }}
                />
                {d.label}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {d.value} ({Math.round((d.value / total) * 100)}%)
                {sub ? ` · ${sub}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number | string;
  hint?: string;
  accent?: 'amber';
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={`text-2xl font-semibold tracking-tight ${
            accent === 'amber' ? 'text-amber-600' : ''
          }`}
        >
          {value}
        </div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

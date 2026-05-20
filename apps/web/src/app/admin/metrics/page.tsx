'use client';

import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminMetrics } from '@/lib/admin/hooks';

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
      <div className="px-6 py-6 text-sm text-muted-foreground">
        No hemos podido cargar las métricas.
      </div>
    );
  }

  const m = metrics.data;
  const moneyFmt = (n: number, currency: string) =>
    n.toLocaleString('es-ES', { style: 'currency', currency });

  return (
    <div className="space-y-6 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Métricas</h1>
        <p className="text-sm text-muted-foreground">
          Vista global de la plataforma. Datos en tiempo real.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Tenants</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <MetricCard label="Total" value={m.tenants.total} />
          <MetricCard label="Trial" value={m.tenants.trial} />
          <MetricCard label="Activos" value={m.tenants.active} />
          <MetricCard label="Suspendidos" value={m.tenants.suspended} />
          <MetricCard label="Cancelados" value={m.tenants.cancelled} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Negocio</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <MetricCard label="MRR" value={moneyFmt(m.mrr.total, m.mrr.currency)} />
          <MetricCard
            label="Ingreso medio por tenant"
            value={moneyFmt(m.averageRevenuePerTenant, m.mrr.currency)}
          />
          <MetricCard label="Altas este mes" value={m.signupsThisMonth} />
          <MetricCard
            label="Churn (mes)"
            value={`${m.churnRatePercent.toFixed(1)}%`}
            hint={`${m.cancellationsThisMonth} cancelaciones`}
          />
        </div>
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

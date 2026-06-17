'use client';

import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useRevenueKpis } from '@/lib/analytics/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export function RevenueKpiCard() {
  const kpis = useRevenueKpis();

  if (kpis.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Revenue</CardTitle>
        </CardHeader>
        <CardContent className="flex h-32 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const d = kpis.data;

  return (
    <section className="grid gap-4 sm:grid-cols-3">
      <MetricCard
        title="RevPAU"
        value={d ? eur(d.revPau) : '—'}
        hint={`Ingreso por trastero disponible (${d?.occupiedUnits ?? 0}/${d?.totalUnits ?? 0} ocupados)`}
      />
      <MetricCard
        title="Estancia media"
        value={d ? `${d.avgLengthOfStayDays} días` : '—'}
        hint="Duración media de los contratos"
      />
      <MetricCard
        title="LTV medio"
        value={d ? eur(d.avgCustomerLtv) : '—'}
        hint="Facturación cobrada media por inquilino"
      />
    </section>
  );
}

function MetricCard(props: { title: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{props.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums">{props.value}</p>
        {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
      </CardContent>
    </Card>
  );
}

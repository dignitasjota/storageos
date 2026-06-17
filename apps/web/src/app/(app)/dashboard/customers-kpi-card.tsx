'use client';

import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCustomerStats } from '@/lib/analytics/hooks';

export function CustomersKpiCard() {
  const stats = useCustomerStats();

  if (stats.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inquilinos</CardTitle>
        </CardHeader>
        <CardContent className="flex h-32 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const data = stats.data;

  return (
    <section className="grid gap-4 sm:grid-cols-3">
      <MetricCard
        title="Inquilinos activos"
        value={String(data?.total ?? 0)}
        hint="Dados de alta y vigentes"
      />
      <MetricCard
        title="Con contrato activo"
        value={String(data?.withActiveContract ?? 0)}
        hint="Generan ingresos recurrentes"
      />
      <MetricCard
        title="Nuevos este mes"
        value={String(data?.newThisMonth ?? 0)}
        hint="Altas desde el día 1"
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

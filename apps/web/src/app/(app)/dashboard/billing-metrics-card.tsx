'use client';

import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useInvoices } from '@/lib/billing/hooks';
import { useContracts } from '@/lib/customers/hooks';

interface AggregatedMetrics {
  mrr: number;
  outstanding: number;
  overdueCount: number;
  paidThisMonth: number;
  collectedThisMonth: number;
}

function isThisMonth(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
}

export function BillingMetricsCard() {
  const invoices = useInvoices();
  const contracts = useContracts({ status: 'active' });

  const metrics = useMemo<AggregatedMetrics>(() => {
    const inv = invoices.data ?? [];
    let outstanding = 0;
    let overdueCount = 0;
    let paidThisMonth = 0;
    let collectedThisMonth = 0;
    for (const i of inv) {
      if (i.status === 'issued' || i.status === 'overdue') {
        outstanding += i.amountPending;
        if (i.status === 'overdue') overdueCount += 1;
      }
      if (i.status === 'paid' && isThisMonth(i.paidAt)) {
        paidThisMonth += 1;
        collectedThisMonth += i.total;
      }
    }
    const mrr = (contracts.data ?? []).reduce((sum, c) => sum + c.effectivePrice, 0);
    return { mrr, outstanding, overdueCount, paidThisMonth, collectedThisMonth };
  }, [invoices.data, contracts.data]);

  const isLoading = invoices.isLoading || contracts.isLoading;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Facturación</CardTitle>
        </CardHeader>
        <CardContent className="flex h-32 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="grid gap-4 md:grid-cols-4">
      <MetricCard
        title="MRR"
        value={metrics.mrr.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
        hint="Cuotas mensuales de contratos activos"
      />
      <MetricCard
        title="Pendiente de cobro"
        value={metrics.outstanding.toLocaleString('es-ES', {
          style: 'currency',
          currency: 'EUR',
        })}
        hint={`${metrics.overdueCount} factura${
          metrics.overdueCount === 1 ? '' : 's'
        } vencida${metrics.overdueCount === 1 ? '' : 's'}`}
        emphasis={metrics.overdueCount > 0}
      />
      <MetricCard
        title="Cobrado este mes"
        value={metrics.collectedThisMonth.toLocaleString('es-ES', {
          style: 'currency',
          currency: 'EUR',
        })}
        hint={`${metrics.paidThisMonth} factura${metrics.paidThisMonth === 1 ? '' : 's'} pagada${
          metrics.paidThisMonth === 1 ? '' : 's'
        }`}
      />
      <MetricCard
        title="Contratos activos"
        value={String((invoices.data ?? []).length === 0 ? 0 : (contracts.data?.length ?? 0))}
        hint="Generan facturación mensual"
      />
    </section>
  );
}

function MetricCard(props: { title: string; value: string; hint?: string; emphasis?: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{props.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p
          className={`text-2xl font-semibold tabular-nums ${
            props.emphasis ? 'text-destructive' : ''
          }`}
        >
          {props.value}
        </p>
        {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
      </CardContent>
    </Card>
  );
}

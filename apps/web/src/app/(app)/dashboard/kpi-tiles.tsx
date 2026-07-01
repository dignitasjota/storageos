'use client';

import {
  Building2,
  Euro,
  PiggyBank,
  TrendingUp,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAging, useCustomerStats, useOccupancy, useRevenueKpis } from '@/lib/analytics/hooks';

const eur = (n: number) =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

const pct = (n: number) => `${(n * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })}%`;

interface Tile {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
  tone?: 'default' | 'positive' | 'warning';
}

const TONE: Record<NonNullable<Tile['tone']>, string> = {
  default: 'bg-primary/10 text-primary',
  positive: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

export function KpiTiles() {
  const revenue = useRevenueKpis();
  const occupancy = useOccupancy();
  const customers = useCustomerStats();
  const aging = useAging();

  const loading =
    revenue.isLoading || occupancy.isLoading || customers.isLoading || aging.isLoading;

  if (loading) {
    return (
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </section>
    );
  }

  const r = revenue.data;
  const o = occupancy.data;
  const c = customers.data;
  const a = aging.data;
  const outstanding = a?.totalOutstanding ?? 0;
  const overdueInvoices = a?.buckets.reduce((s, b) => s + b.invoiceCount, 0) ?? 0;

  const tiles: Tile[] = [
    {
      icon: Euro,
      label: 'MRR',
      value: r ? eur(r.mrr) : '—',
      hint: 'Ingresos recurrentes mensuales',
      tone: 'positive',
    },
    {
      icon: Building2,
      label: 'Ocupación física',
      value: o ? pct(o.physicalOccupancy) : '—',
      hint: o ? `${o.occupiedUnits}/${o.totalUnits} trasteros ocupados` : '',
    },
    {
      icon: Users,
      label: 'Inquilinos activos',
      value: c ? String(c.withActiveContract) : '—',
      hint: c ? `${c.total} dados de alta en total` : '',
    },
    {
      icon: PiggyBank,
      label: 'Pendiente de cobro',
      value: eur(outstanding),
      hint: `${overdueInvoices} factura${overdueInvoices === 1 ? '' : 's'} sin cobrar`,
      tone: outstanding > 0 ? 'warning' : 'default',
    },
    {
      icon: UserPlus,
      label: 'Nuevos este mes',
      value: c ? String(c.newThisMonth) : '—',
      hint: 'Altas de inquilinos desde el día 1',
    },
    {
      icon: TrendingUp,
      label: 'RevPAU',
      value: r ? eur(r.revPau) : '—',
      hint: 'Ingreso por trastero disponible',
    },
  ];

  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <Card key={t.label} className="transition-shadow hover:shadow-soft">
          <CardContent className="space-y-3 p-5">
            <span
              className={`flex size-9 items-center justify-center rounded-lg ${TONE[t.tone ?? 'default']}`}
            >
              <t.icon className="size-4.5" />
            </span>
            <div className="space-y-0.5">
              <p className="text-xs text-muted-foreground">{t.label}</p>
              <p className="text-2xl font-semibold tracking-tight tabular-nums">{t.value}</p>
              {t.hint ? <p className="truncate text-xs text-muted-foreground">{t.hint}</p> : null}
            </div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

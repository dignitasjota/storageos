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

import type { DashboardOverviewDto } from '@storageos/shared';

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

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

const UNAVAILABLE = 'No disponible';

export function KpiTiles({
  data,
  loading,
}: {
  data: DashboardOverviewDto | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </section>
    );
  }

  const r = data?.revenue;
  const o = data?.occupancy;
  const c = data?.customers;
  const d = data?.receivables;
  const target = data?.month?.targetOccupancyPct;

  const tiles: Tile[] = [
    {
      icon: Euro,
      label: 'MRR',
      value: r ? eur(r.mrr) : '—',
      hint: r ? 'Ingresos recurrentes mensuales' : UNAVAILABLE,
      tone: 'positive',
    },
    {
      icon: Building2,
      label: 'Ocupación física',
      value: o ? pct(o.physicalOccupancy) : '—',
      hint: o
        ? `${o.occupiedUnits} de ${o.totalUnits}${target ? ` · objetivo ${target} %` : ''}`
        : UNAVAILABLE,
    },
    {
      icon: Users,
      label: 'Inquilinos activos',
      value: c ? String(c.withActiveContract) : '—',
      hint: c ? `${c.total} fichas en total` : UNAVAILABLE,
    },
    {
      icon: PiggyBank,
      label: 'Pendiente de cobro',
      value: d ? eur(d.total) : '—',
      hint: d
        ? d.overdue > 0
          ? `${eur(d.overdue)} vencido`
          : `${d.invoices} ${d.invoices === 1 ? 'factura' : 'facturas'} en plazo`
        : UNAVAILABLE,
      tone: d && d.overdue > 0 ? 'warning' : 'default',
    },
    {
      icon: UserPlus,
      label: 'Nuevos este mes',
      value: c ? String(c.newThisMonth) : '—',
      hint: c ? 'Con su primer contrato' : UNAVAILABLE,
    },
    {
      icon: TrendingUp,
      label: 'RevPAU',
      value: r ? eur(r.revPau) : '—',
      hint: r ? 'Ingreso por trastero' : UNAVAILABLE,
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
              <p className="text-xs text-muted-foreground">{t.hint}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

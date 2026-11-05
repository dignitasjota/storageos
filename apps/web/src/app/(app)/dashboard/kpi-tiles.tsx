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
import Link from 'next/link';

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
  /** Qué significa la cifra. */
  help: string;
  href: string;
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
      label: 'Cuotas al mes',
      value: r ? eur(r.mrr) : '—',
      hint: r ? 'Lo que se factura cada mes' : UNAVAILABLE,
      help: 'Suma de las cuotas de los contratos en vigor, sin IVA y con sus descuentos.',
      href: '/contracts',
      tone: 'positive',
    },
    {
      icon: Building2,
      label: 'Ocupación',
      value: o ? pct(o.physicalOccupancy) : '—',
      hint: o
        ? `${o.occupiedUnits} de ${o.totalUnits}${target ? ` · objetivo ${target} %` : ''}`
        : UNAVAILABLE,
      help: 'Trasteros alquilados sobre el total. El objetivo se fija en la estrategia de precios.',
      href: '/units',
    },
    {
      icon: Users,
      label: 'Inquilinos activos',
      value: c ? String(c.withActiveContract) : '—',
      hint: c ? `${c.total} fichas en total` : UNAVAILABLE,
      help: 'Inquilinos con algún contrato en vigor.',
      href: '/customers',
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
      help: 'Todo lo emitido y aún sin cobrar, venza cuando venza. Sin fianzas.',
      href: d && d.overdue > 0 ? '/arrears' : '/collections-month',
      tone: d && d.overdue > 0 ? 'warning' : 'default',
    },
    {
      icon: UserPlus,
      label: 'Nuevos este mes',
      value: c ? String(c.newThisMonth) : '—',
      hint: c ? 'Con su primer contrato' : UNAVAILABLE,
      help: 'Inquilinos cuyo primer contrato ha empezado este mes.',
      href: '/customers',
    },
    {
      icon: TrendingUp,
      label: 'Ingreso por trastero',
      value: r ? eur(r.revPau) : '—',
      hint: r ? 'Al mes, contando los libres' : UNAVAILABLE,
      help: 'Cuotas al mes entre todos tus trasteros, alquilados o no.',
      href: '/analytics?tab=revenue',
    },
  ];

  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <Link key={t.label} href={t.href} title={t.help} className="block rounded-xl">
          <Card className="h-full transition-shadow hover:shadow-soft">
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
        </Link>
      ))}
    </section>
  );
}

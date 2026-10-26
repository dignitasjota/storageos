'use client';

import Link from 'next/link';

import type { TodaySummaryDto } from '@storageos/shared';

import { Delta } from '@/app/(app)/analytics/period';
import { Card, CardContent } from '@/components/ui/card';

function eur(n: number): string {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

const VS = 'vs el mes pasado a estas alturas';

/**
 * Cifras del mes en curso frente al mes anterior hasta el mismo día: lo
 * cobrado y lo facturado, la ocupación con su objetivo y las altas y bajas.
 * La usan «Hoy» y el Resumen.
 */
export function MonthStrip({ summary }: { summary: TodaySummaryDto | undefined }) {
  if (!summary) return null;
  const k = summary.kpis;
  const pct = k.invoicedMonth > 0 ? Math.min(100, (k.collectedMonth / k.invoicedMonth) * 100) : 0;
  const target = k.targetOccupancyPct;
  const targetPct = Math.min(100, Math.max(0, target));
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="sm:col-span-2">
        <CardContent className="space-y-2 pt-6">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs text-muted-foreground">Cobrado este mes</p>
            <p className="text-xs text-muted-foreground">
              Facturado este mes: {eur(k.invoicedMonth)}
            </p>
          </div>
          <p className="text-2xl font-semibold tabular-nums">{eur(k.collectedMonth)}</p>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>
          <p className="flex flex-wrap gap-x-3 text-xs">
            <Delta current={k.collectedMonth} previous={k.previous?.collectedMonth} suffix={VS} />
            <span className="text-muted-foreground">
              Lo cobrado incluye facturas de meses anteriores.
            </span>
          </p>
          {k.overduePending > 0 && (
            <Link
              href="/arrears"
              className="block text-xs font-medium text-red-600 hover:underline"
            >
              {eur(k.overduePending)} vencido sin cobrar →
            </Link>
          )}
        </CardContent>
      </Card>
      <Link href="/units">
        <Card className="h-full">
          <CardContent className="space-y-1 pt-6">
            <p className="text-xs text-muted-foreground">Ocupación</p>
            <p className="text-2xl font-semibold tabular-nums">{k.occupancyPct}%</p>
            {/* Barra con la marca del objetivo de la estrategia de precios. */}
            <div className="relative h-2 rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, k.occupancyPct)}%` }}
              />
              <div
                className="absolute -top-0.5 h-3 w-0.5 bg-foreground"
                style={{ left: `${targetPct}%` }}
                title={`Objetivo ${target}%`}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {k.unitsToTarget > 0
                ? `Objetivo ${target}%: faltan ${k.unitsToTarget} ${k.unitsToTarget === 1 ? 'trastero' : 'trasteros'}`
                : `Objetivo ${target}% alcanzado`}{' '}
              · {k.freeUnits} libres de {k.totalUnits}
            </p>
          </CardContent>
        </Card>
      </Link>
      <Link href="/contracts">
        <Card className="h-full">
          <CardContent className="space-y-1 pt-6">
            <p className="text-xs text-muted-foreground">Este mes</p>
            <p className="text-2xl font-semibold tabular-nums">
              <span className="text-emerald-700 dark:text-emerald-400">+{k.moveInsMonth}</span>{' '}
              <span className="text-red-600">−{k.moveOutsMonth}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              altas y bajas · el mes pasado +{k.previous?.moveInsMonth ?? 0} −
              {k.previous?.moveOutsMonth ?? 0}
            </p>
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}

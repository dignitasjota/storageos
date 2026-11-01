'use client';

import { Loader2 } from 'lucide-react';

import type { CatalogPriceChangeDto } from '@storageos/shared';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/** Lista de cambios de precio de un plan o extra. */
export function PriceHistoryList({
  loading,
  rows,
  withYearly = false,
}: {
  loading: boolean;
  rows: CatalogPriceChangeDto[];
  withYearly?: boolean;
}) {
  if (loading) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin cambios de precio registrados.</p>;
  }
  const money = (n: number | null) => (n == null ? '—' : eur(n));
  return (
    <ul className="divide-y text-sm">
      {rows.map((r) => (
        <li key={r.id} className="py-2">
          <div className="flex flex-wrap justify-between gap-2">
            <span className="tabular-nums">
              {r.oldPriceMonthly == null ? 'Alta' : money(r.oldPriceMonthly)} →{' '}
              {money(r.newPriceMonthly)} /mes
              {withYearly &&
                r.oldPriceYearly !== r.newPriceYearly &&
                ` · ${money(r.oldPriceYearly)} → ${money(r.newPriceYearly)} /año`}
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(r.createdAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}
              {r.superAdminName ? ` · ${r.superAdminName}` : ''}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

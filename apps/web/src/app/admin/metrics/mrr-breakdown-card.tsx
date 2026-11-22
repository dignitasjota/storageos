'use client';

import type { AdminMrrBreakdownDto } from '@storageos/shared';

import { useOpenBreakdown } from '@/components/admin/metrics/breakdown-sheet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEur, formatPct, plural } from '@/lib/format';

/** De qué está hecho el MRR: plan mensual, anual repartido, extras y descuentos. */
export function MrrBreakdownCard({ b }: { b: AdminMrrBreakdownDto }) {
  const open = useOpenBreakdown();
  const parts = [
    {
      label: 'Plan, pago mensual',
      value: b.planMonthly,
      hint: plural(b.monthlyTenants, 'cliente', 'clientes'),
      color: '#2563eb',
    },
    {
      label: 'Plan anual repartido (÷ 12)',
      value: b.planYearly,
      hint: plural(b.yearlyTenants, 'cliente', 'clientes'),
      color: '#1baf7a',
    },
    { label: 'Extras', value: b.addons, hint: null, color: '#eda100' },
  ];
  const listPrice = b.total + b.discounts;
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">De qué está hecho el MRR (sin IVA)</CardTitle>
        <p className="text-xs text-muted-foreground">
          Cuota real de quien paga: la anual entre 12, con su descuento, más los extras. Pulsa el
          total para ver los clientes.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <button
          type="button"
          className="text-left text-2xl font-semibold tabular-nums hover:underline"
          onClick={() => open({ metric: 'paying' })}
        >
          {formatEur(b.total)}
        </button>
        {b.total > 0 && (
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
            {parts.map((p) => (
              <div
                key={p.label}
                style={{ width: `${(p.value / b.total) * 100}%`, backgroundColor: p.color }}
              />
            ))}
          </div>
        )}
        <ul className="space-y-1.5 text-sm">
          {parts.map((p) => (
            <li key={p.label} className="flex items-start justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="inline-block size-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: p.color }}
                />
                <span className="min-w-0">
                  {p.label}
                  {p.hint && <span className="text-xs text-muted-foreground"> · {p.hint}</span>}
                </span>
              </span>
              <span className="shrink-0 tabular-nums">{formatEur(p.value)}</span>
            </li>
          ))}
          <li className="flex items-start justify-between gap-2 border-t pt-1.5">
            <span className="min-w-0 text-amber-700 dark:text-amber-400">
              Descuentos que se dejan de ingresar
              <span className="text-xs text-muted-foreground">
                {' '}
                · {plural(b.discountedTenants, 'cliente', 'clientes')}
                {listPrice > 0 ? ` · ${formatPct((b.discounts / listPrice) * 100)} del precio` : ''}
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-amber-700 dark:text-amber-400">
              {b.discounts > 0 ? `−${formatEur(b.discounts)}` : formatEur(0)}
            </span>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}

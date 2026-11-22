'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { monthLabelKey } from '@/components/admin/metrics/annotation-lines';
import { useOpenBreakdown } from '@/components/admin/metrics/breakdown-sheet';
import { CsvButton } from '@/components/admin/metrics/csv-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminRetention } from '@/lib/admin/hooks';
import { formatEur, formatPct } from '@/lib/format';

/** Color de la celda según el % de retención (verde alto → rojo bajo). */
function cellStyle(pct: number | null): { className: string; text: string } {
  if (pct === null) return { className: 'bg-transparent text-transparent', text: '' };
  const text = formatPct(pct, 0);
  if (pct >= 90) return { className: 'bg-green-600 text-white', text };
  if (pct >= 75) return { className: 'bg-green-500 text-white', text };
  if (pct >= 60) return { className: 'bg-green-400 text-green-950', text };
  if (pct >= 45) return { className: 'bg-yellow-400 text-yellow-950', text };
  if (pct >= 30) return { className: 'bg-orange-400 text-orange-950', text };
  if (pct >= 15) return { className: 'bg-orange-500 text-white', text };
  return { className: 'bg-red-500 text-white', text };
}

export function RetentionCohortsCard({ months = 12 }: { months?: number }) {
  const q = useAdminRetention(months);
  const [mode, setMode] = useState<'clients' | 'money'>('clients');
  const open = useOpenBreakdown();
  const money = mode === 'money';

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">Cohortes de retención</CardTitle>
          <div className="flex items-center gap-1">
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Medir">
              {(
                [
                  ['clients', 'Clientes'],
                  ['money', 'Dinero'],
                ] as const
              ).map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={mode === key ? 'secondary' : 'ghost'}
                  className="h-7 px-2 text-xs"
                  aria-pressed={mode === key}
                  onClick={() => setMode(key)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <CsvButton
              filename={money ? 'cohortes-dinero.csv' : 'cohortes-clientes.csv'}
              disabled={!q.data}
              rows={() => [
                [
                  'Cohorte',
                  money ? 'MRR inicial sin IVA' : 'Clientes',
                  ...Array.from({ length: (q.data?.maxOffset ?? 0) + 1 }, (_, k) => `M${k} (%)`),
                ],
                ...(q.data?.cohorts ?? []).map((c) => [
                  c.cohort,
                  money ? c.startMrr : c.size,
                  ...(money ? c.revenueRetention : c.retention).map((v) => v ?? ''),
                ]),
              ]}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {money
            ? 'De los tenants que llegaron a pagar, por mes de alta, qué % de su MRR inicial se conserva N meses después de su primer pago (NRR por cohorte; puede pasar del 100 % con subidas de plan o extras).'
            : 'De los tenants que llegaron a pagar, por mes de alta, qué % seguía con nosotros N meses después (M0 = al alta). Una prueba que acaba sin pagar no cuenta; quien pagó y quedó en solo lectura, sí (como baja).'}{' '}
          Pulsa una cohorte para ver sus clientes.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !q.data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : q.data.cohorts.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Aún no hay cohortes de clientes.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-1 text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="px-2 py-1 text-left font-medium">Cohorte</th>
                  <th className="px-2 py-1 text-right font-medium">
                    {money ? 'MRR inicial' : 'Clientes'}
                  </th>
                  {Array.from({ length: q.data.maxOffset + 1 }, (_, k) => (
                    <th key={k} className="px-2 py-1 text-center font-medium">
                      M{k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.cohorts.map((c) => (
                  <tr key={c.cohort}>
                    <td className="whitespace-nowrap px-2 py-1 font-medium">
                      {c.size > 0 ? (
                        <button
                          type="button"
                          className="hover:underline"
                          onClick={() => {
                            const month = monthLabelKey(c.cohort);
                            if (month) open({ metric: 'cohort', month });
                          }}
                        >
                          {c.cohort}
                        </button>
                      ) : (
                        c.cohort
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-muted-foreground">
                      {money ? formatEur(c.startMrr) : c.size}
                    </td>
                    {Array.from({ length: q.data!.maxOffset + 1 }, (_, k) => {
                      const values = money ? c.revenueRetention : c.retention;
                      // Un mes sin altas no tiene porcentaje.
                      const s =
                        c.size === 0 && k === 0
                          ? { className: 'text-muted-foreground', text: '—' }
                          : cellStyle(values[k] ?? null);
                      return (
                        <td
                          key={k}
                          className={`rounded px-2 py-1 text-center tabular-nums ${s.className}`}
                        >
                          {s.text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

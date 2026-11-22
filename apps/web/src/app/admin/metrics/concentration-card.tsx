'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';

import { useOpenBreakdown } from '@/components/admin/metrics/breakdown-sheet';
import { CsvButton } from '@/components/admin/metrics/csv-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useConcentration } from '@/lib/admin/metrics-insights-hooks';
import { formatEur, formatPct, plural } from '@/lib/format';

/** Nivel del índice de Herfindahl (0-10 000). */
function hhiLevel(hhi: number): { text: string; className: string } {
  if (hhi >= 2500) return { text: 'muy concentrado', className: 'text-red-700 dark:text-red-400' };
  if (hhi >= 1500) {
    return { text: 'concentrado', className: 'text-amber-700 dark:text-amber-400' };
  }
  return { text: 'repartido', className: 'text-green-700 dark:text-green-400' };
}

/** Peso de los mayores clientes en el MRR. */
export function ConcentrationCard() {
  const q = useConcentration();
  const open = useOpenBreakdown();
  const d = q.data;
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">Concentración de ingresos</CardTitle>
          <CsvButton
            filename="concentracion.csv"
            disabled={!d}
            rows={() => [
              ['Tenant', 'MRR sin IVA', '% del MRR'],
              ...(d?.top ?? []).map((t) => [t.name, t.mrr, t.sharePct]),
            ]}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Cuánto del MRR (sin IVA) depende de los mayores clientes. El índice va de 0 (muy
          repartido) a 10 000 (un solo cliente).
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : d.payingTenants === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Aún no hay clientes que paguen.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  ['Mayor cliente', d.top1Pct],
                  ['5 mayores', d.top5Pct],
                  ['10 mayores', d.top10Pct],
                ] as const
              ).map(([label, v]) => (
                <div key={label} className="min-w-0 rounded-lg border px-3 py-2">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="text-lg font-semibold tabular-nums">{formatPct(v)}</div>
                </div>
              ))}
              <div className="min-w-0 rounded-lg border px-3 py-2">
                <div className="text-xs text-muted-foreground">Índice</div>
                <div className="text-lg font-semibold tabular-nums">{d.hhi}</div>
                <div className={`text-xs ${hhiLevel(d.hhi).className}`}>{hhiLevel(d.hhi).text}</div>
              </div>
            </div>
            {d.overThreshold > 0 && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                {plural(d.overThreshold, 'cliente pesa', 'clientes pesan')} más del {d.thresholdPct}{' '}
                % del MRR (el umbral de los avisos de negocio).
              </p>
            )}
            <ul className="divide-y rounded-md border text-sm">
              {d.top.map((t) => (
                <li key={t.tenantId} className="flex items-center justify-between gap-2 p-2">
                  <Link
                    href={`/admin/tenants/${t.tenantId}`}
                    className="min-w-0 truncate hover:underline"
                  >
                    {t.name}
                  </Link>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatEur(t.mrr)} · {formatPct(t.sharePct)}
                  </span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => open({ metric: 'concentration' })}
            >
              Ver los {d.payingTenants} clientes que pagan
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

'use client';

import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCashMonth } from '@/lib/admin/metrics-insights-hooks';
import { formatEur, formatPct } from '@/lib/format';

/** Lo cobrado este mes y lo que queda por cobrar, frente al objetivo de cobro mensual. */
export function CashMonthCard() {
  const q = useCashMonth();
  const d = q.data;
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Caja prevista {d ? `de ${d.label}` : 'del mes'}</CardTitle>
        <p className="text-xs text-muted-foreground">
          Lo cobrado este mes (neto) más los cargos que vencen antes de que acabe, con IVA. El
          objetivo se pone en Métricas → Objetivos.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="Cobrado" value={formatEur(d.collected)} />
              <Figure label="Queda por cobrar" value={formatEur(d.expectedRest)} />
              <Figure label="Previsto al cierre" value={formatEur(d.projected)} />
              <Figure
                label="Vencido sin cobrar"
                value={formatEur(d.overdue)}
                warn={d.overdue > 0}
              />
            </div>
            {d.target !== null ? (
              <div className="space-y-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span>Objetivo: {formatEur(d.target)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatPct(d.collectedPct ?? 0, 0)} cobrado ·{' '}
                    {formatPct(d.projectedPct ?? 0, 0)} previsto
                  </span>
                </div>
                <div
                  className="relative h-2.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label="Cobrado frente al objetivo"
                  aria-valuenow={Math.round(d.collectedPct ?? 0)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-primary/30"
                    style={{ width: `${Math.min(d.projectedPct ?? 0, 100)}%` }}
                  />
                  <div
                    className={`absolute inset-y-0 left-0 rounded-full ${
                      (d.collectedPct ?? 0) >= 100 ? 'bg-green-600' : 'bg-primary'
                    }`}
                    style={{ width: `${Math.min(d.collectedPct ?? 0, 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Barra oscura: cobrado. Clara: lo previsto si se cobra todo lo que vence este mes.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Sin objetivo de cobro mensual. Ponlo en Métricas → Objetivos para ver el progreso.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold tabular-nums ${warn ? 'text-amber-700 dark:text-amber-400' : ''}`}
      >
        {value}
      </p>
    </div>
  );
}

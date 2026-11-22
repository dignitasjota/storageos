'use client';

import { Loader2 } from 'lucide-react';

import { CsvButton } from '@/components/admin/metrics/csv-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminPaymentRetries } from '@/lib/admin/hooks';
import { formatEur, formatPct } from '@/lib/format';

const SOURCE_LABELS: Record<'stripe' | 'sepa' | 'redsys', string> = {
  stripe: 'Stripe',
  sepa: 'Adeudos SEPA',
  redsys: 'Redsys automático',
};

export function PaymentRetriesCard({ months = 12 }: { months?: number }) {
  const q = useAdminPaymentRetries(months);
  const d = q.data;

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">Recuperación de cobros</CardTitle>
          <CsvButton
            filename="cobros-recuperados.csv"
            disabled={!q.data}
            rows={() => [
              ['Forma de cobro', 'Fallidos', 'Recuperados'],
              ...(q.data?.bySource ?? []).map((s) => [
                SOURCE_LABELS[s.source],
                s.totalFailed,
                s.recovered,
              ]),
              ['Total', q.data?.totalFailed ?? 0, q.data?.recovered ?? 0],
            ]}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          De los cobros de suscripción que fallaron al menos una vez (últimos {months} meses:
          Stripe, adeudos SEPA devueltos y cobros automáticos de Redsys), cuántos se acabaron
          cobrando.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : d.totalFailed === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Sin cobros fallidos en los últimos {months} meses. 🎉
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold">{formatPct(d.recoveryRatePercent, 0)}</span>
              <span className="text-sm text-muted-foreground">
                recuperados ({d.recovered}/{d.totalFailed})
              </span>
            </div>
            {/* Barra recuperado vs en riesgo */}
            <div className="flex h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-green-500"
                style={{ width: `${(d.recovered / d.totalFailed) * 100}%` }}
              />
              <div
                className="h-full bg-red-500"
                style={{ width: `${(d.stillFailing / d.totalFailed) * 100}%` }}
              />
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Recuperado</dt>
                <dd className="font-medium text-green-600 dark:text-green-400">
                  {formatEur(d.amountRecovered)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">En riesgo</dt>
                <dd className="font-medium text-red-600 dark:text-red-400">
                  {formatEur(d.amountAtRisk)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Sin recuperar</dt>
                <dd className="font-medium">{d.stillFailing}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Intentos medios</dt>
                <dd className="font-medium">{d.avgAttempts.toFixed(1).replace('.', ',')}</dd>
              </div>
            </dl>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {d.bySource
                .filter((s) => s.totalFailed > 0)
                .map((s) => (
                  <li key={s.source} className="flex justify-between">
                    <span>{SOURCE_LABELS[s.source]}</span>
                    <span className="tabular-nums">
                      {s.recovered}/{s.totalFailed} recuperados
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

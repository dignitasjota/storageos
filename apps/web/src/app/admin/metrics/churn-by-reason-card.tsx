'use client';

import { Loader2 } from 'lucide-react';

import { CsvButton } from '@/components/admin/metrics/csv-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { churnReasonLabel } from '@/lib/admin/churn';
import { useAdminChurnByReason } from '@/lib/admin/hooks';
import { formatEur } from '@/lib/format';

export function ChurnByReasonCard({ months = 12 }: { months?: number }) {
  const q = useAdminChurnByReason(months);
  const data = q.data;
  const max = data ? Math.max(1, ...data.slices.map((s) => s.count)) : 1;

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">Churn por razón</CardTitle>
          <CsvButton
            filename="churn-por-razon.csv"
            disabled={!q.data}
            rows={() => [
              ['Motivo', 'Bajas', 'Con motivo apuntado', 'MRR perdido sin IVA'],
              ...(q.data?.slices ?? []).map((s) => [
                churnReasonLabel(s.reason),
                s.count,
                s.captured,
                s.lostMrr,
              ]),
            ]}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Bajas de clientes que pagaban en los últimos {months} meses, por motivo. El motivo se
          captura al suspender; las bajas sin motivo se infieren (impago / voluntaria). Una prueba
          que acaba sin pagar no es baja.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : data.totalChurned === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Sin bajas de tenants en los últimos {months} meses. 🎉
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-6 text-sm">
              <div>
                <div className="text-2xl font-semibold">{data.totalChurned}</div>
                <div className="text-xs text-muted-foreground">
                  {data.totalChurned === 1 ? 'baja' : 'bajas'}
                </div>
              </div>
              <div>
                <div className="text-2xl font-semibold text-red-600 dark:text-red-400">
                  {formatEur(data.lostMrr)}
                </div>
                <div className="text-xs text-muted-foreground">MRR perdido / mes (sin IVA)</div>
              </div>
            </div>
            <ul className="space-y-2">
              {data.slices.map((s) => (
                <li key={s.reason} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0">
                      {churnReasonLabel(s.reason)}
                      {s.captured < s.count && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({s.captured}/{s.count} con motivo)
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {s.count} · {formatEur(s.lostMrr)}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-red-500"
                      style={{ width: `${(s.count / max) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

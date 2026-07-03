'use client';

import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { churnReasonLabel } from '@/lib/admin/churn';
import { useAdminChurnByReason } from '@/lib/admin/hooks';

const eur = (n: number) =>
  new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(n);

export function ChurnByReasonCard() {
  const q = useAdminChurnByReason(12);
  const data = q.data;
  const max = data ? Math.max(1, ...data.slices.map((s) => s.count)) : 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Churn por razón</CardTitle>
        <p className="text-xs text-muted-foreground">
          Bajas de tenants de los últimos 12 meses agrupadas por motivo. El motivo se captura al
          suspender; las bajas sin motivo se infieren (impago / voluntaria).
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : data.totalChurned === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Sin bajas de tenants en los últimos 12 meses. 🎉
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-6 text-sm">
              <div>
                <div className="text-2xl font-semibold">{data.totalChurned}</div>
                <div className="text-xs text-muted-foreground">bajas</div>
              </div>
              <div>
                <div className="text-2xl font-semibold text-red-600 dark:text-red-400">
                  {eur(data.lostMrr)}
                </div>
                <div className="text-xs text-muted-foreground">MRR perdido / mes</div>
              </div>
            </div>
            <ul className="space-y-2">
              {data.slices.map((s) => (
                <li key={s.reason} className="space-y-1">
                  <div className="flex items-baseline justify-between text-sm">
                    <span>
                      {churnReasonLabel(s.reason)}
                      {s.captured < s.count && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({s.captured}/{s.count} con motivo)
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      {s.count} · {eur(s.lostMrr)}
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

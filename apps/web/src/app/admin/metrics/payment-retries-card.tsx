'use client';

import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminPaymentRetries } from '@/lib/admin/hooks';

const eur = (n: number) =>
  new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(n);

export function PaymentRetriesCard() {
  const q = useAdminPaymentRetries(12);
  const d = q.data;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Recuperación de cobros</CardTitle>
        <p className="text-xs text-muted-foreground">
          De las facturas de suscripción que fallaron al menos una vez (últimos 12 meses), cuántas
          se acabaron cobrando.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : d.totalFailed === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Sin cobros fallidos en los últimos 12 meses. 🎉
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold">{d.recoveryRatePercent.toFixed(0)}%</span>
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
                  {eur(d.amountRecovered)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">En riesgo</dt>
                <dd className="font-medium text-red-600 dark:text-red-400">
                  {eur(d.amountAtRisk)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Sin recuperar</dt>
                <dd className="font-medium">{d.stillFailing}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Intentos medios</dt>
                <dd className="font-medium">{d.avgAttempts.toFixed(1)}</dd>
              </div>
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

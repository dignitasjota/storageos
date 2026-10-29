'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';

import type { AdminChargeMethod } from '@storageos/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCollectionsForecast } from '@/lib/admin/business-hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

const METHODS: { key: AdminChargeMethod; label: string; color: string }[] = [
  { key: 'stripe', label: 'Stripe', color: '#2a78d6' },
  { key: 'sepa', label: 'Remesa SEPA', color: '#eb6834' },
  { key: 'redsys', label: 'Redsys', color: '#1baf7a' },
  { key: 'manual', label: 'A mano', color: '#eda100' },
];

/** Lo que se espera cobrar en los próximos 90 días y lo que está en riesgo. */
export function ForecastCard() {
  const q = useCollectionsForecast();
  const d = q.data;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Previsión de cobros</CardTitle>
        <p className="text-xs text-muted-foreground">
          Cuotas y extras que vencen en los próximos 90 días según cómo paga cada tenant
          {d ? (d.pricesIncludeVat ? ' (IVA incluido)' : ' (más IVA)') : ''}.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {d.buckets.map((b) => (
                <div key={b.label} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{b.label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{eur(b.total)}</p>
                  <p className="text-xs text-muted-foreground">{b.count} cargo(s)</p>
                  <ul className="mt-2 space-y-0.5 text-xs">
                    {METHODS.filter((m) => b.byMethod[m.key] > 0).map((m) => (
                      <li key={m.key} className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5">
                          <span
                            className="inline-block size-2 rounded-sm"
                            style={{ backgroundColor: m.color }}
                          />
                          {m.label}
                        </span>
                        <span className="tabular-nums">{eur(b.byMethod[m.key])}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <Link href="/admin/receivables" className="rounded-lg border p-3 hover:bg-muted/50">
                <p className="text-xs text-muted-foreground">Vencido sin cobrar</p>
                <p
                  className={`font-semibold tabular-nums ${d.overdue.total > 0 ? 'text-red-700 dark:text-red-400' : ''}`}
                >
                  {eur(d.overdue.total)}
                </p>
                <p className="text-xs text-muted-foreground">{d.overdue.count} cobro(s)</p>
              </Link>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">En una remesa SEPA</p>
                <p className="font-semibold tabular-nums">{eur(d.inSepaRemittance.total)}</p>
                <p className="text-xs text-muted-foreground">
                  {d.inSepaRemittance.count} adeudo(s) por confirmar
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">
                  Tarjetas con el último cobro rechazado
                </p>
                <p
                  className={`font-semibold tabular-nums ${d.cardIssues > 0 ? 'text-amber-700 dark:text-amber-400' : ''}`}
                >
                  {d.cardIssues}
                </p>
                <p className="text-xs text-muted-foreground">cobro automático de Redsys</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

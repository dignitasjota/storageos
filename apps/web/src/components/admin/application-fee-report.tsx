'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApplicationFeeReport } from '@/lib/admin/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const monthLabel = (key: string) =>
  new Date(`${key}-15T12:00:00Z`).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

/** Comisión cobrada en los cobros con tarjeta de los tenants, por mes y por tenant. */
export function ApplicationFeeReport({ months = 12 }: { months?: number }) {
  const report = useApplicationFeeReport(months);
  const d = report.data;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Comisiones por cobros con tarjeta{d ? ` · ${eur(d.total)} en ${months} meses` : ''}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {report.isLoading || !d ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : d.total === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay cobros con tarjeta de los tenants con comisión.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-normal">Mes</th>
                  <th className="py-1 pr-3 text-right font-normal">Cobros</th>
                  <th className="py-1 text-right font-normal">Comisión</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {[...d.months]
                  .reverse()
                  .filter((m) => m.charges > 0)
                  .map((m) => (
                    <tr key={m.month} className="border-t">
                      <td className="py-1 pr-3 capitalize">{monthLabel(m.month)}</td>
                      <td className="py-1 pr-3 text-right">{m.charges}</td>
                      <td className="py-1 text-right font-medium">{eur(m.fee)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Los tenants que más dejan</p>
              <ul className="divide-y text-sm">
                {d.topTenants.map((t) => (
                  <li key={t.tenantId} className="flex justify-between gap-2 py-1">
                    <Link href={`/admin/tenants/${t.tenantId}`} className="hover:underline">
                      {t.tenantName}
                    </Link>
                    <span className="tabular-nums">{eur(t.fee)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

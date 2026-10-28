'use client';

import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePreOpeningAnalytics } from '@/lib/analytics/hooks';
import { formatDate, formatEur } from '@/lib/format';

/**
 * Preventa de los locales por abrir: trasteros ya reservados antes de la
 * apertura, por tipo, para decidir el precio de los que quedan.
 */
export function PreOpeningCard({ facilityId }: { facilityId?: string }) {
  const query = usePreOpeningAnalytics({ ...(facilityId ? { facilityId } : {}) });
  const facilities = query.data?.facilities ?? [];
  if (facilities.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Preventa de locales por abrir</CardTitle>
        <CardDescription>
          Trasteros ya reservados antes de la apertura. Las cuotas reservadas empiezan a facturarse
          el día que abre el local.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {facilities.map((f) => {
          const pct = f.totalUnits > 0 ? Math.round((f.reserved / f.totalUnits) * 100) : 0;
          return (
            <div key={f.facilityId} className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`/facilities/${f.facilityId}?tab=settings`}
                  className="font-medium hover:underline"
                >
                  {f.facilityName}
                </Link>
                <span className="text-sm text-muted-foreground">
                  {f.openingDate ? `Abre el ${formatDate(f.openingDate)}` : 'Sin fecha de apertura'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Stat label="Reservados" value={`${f.reserved} de ${f.totalUnits} (${pct} %)`} />
                <Stat label="Sin pagar" value={String(f.unpaid)} warn={f.unpaid > 0} />
                <Stat label="Cuotas reservadas" value={`${formatEur(f.reservedMrr)}/mes`} />
                <Stat label="Si se alquila todo" value={`${formatEur(f.potentialMrr)}/mes`} />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-1.5 pr-3 font-medium">Tipo</th>
                      <th className="py-1.5 pr-3 font-medium">Reservados</th>
                      <th className="py-1.5 pr-3 font-medium">Libres</th>
                      <th className="py-1.5 font-medium">Desde (sin IVA)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.byType.map((t) => {
                      const typePct = t.total > 0 ? (t.reserved / t.total) * 100 : 0;
                      return (
                        <tr key={t.unitTypeId ?? 'none'} className="border-b last:border-0">
                          <td className="py-2 pr-3">{t.name}</td>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-2">
                              <span className="tabular-nums">
                                {t.reserved}/{t.total}
                              </span>
                              <div
                                className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"
                                aria-hidden
                              >
                                <div
                                  className="h-full rounded-full bg-primary"
                                  style={{ width: `${typePct}%` }}
                                />
                              </div>
                              {t.available === 0 && t.total > 0 && (
                                <Badge variant="secondary">Agotado</Badge>
                              )}
                            </div>
                          </td>
                          <td className="py-2 pr-3 tabular-nums">{t.available}</td>
                          <td className="py-2 tabular-nums">
                            {t.fromPrice === null ? '—' : formatEur(t.fromPrice)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-medium tabular-nums ${warn ? 'text-amber-600 dark:text-amber-400' : ''}`}>
        {value}
      </p>
    </div>
  );
}

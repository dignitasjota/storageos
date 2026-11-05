'use client';

import { Boxes } from 'lucide-react';
import Link from 'next/link';

import type { DashboardVacancyDto } from '@storageos/shared';

import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEur } from '@/lib/format';

/** Lo que hay libre y lo que deja de entrar cada mes por ello. */
export function VacancyCard({
  data,
  loading,
  onRetry,
}: {
  data: DashboardVacancyDto | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Boxes className="size-4 text-sky-500" />
          Trasteros libres
        </CardTitle>
        <CardDescription>
          {data && data.freeUnits > 0 ? (
            <>
              {data.freeUnits} libres: dejas de ingresar{' '}
              <span className="font-medium text-foreground">{formatEur(data.monthlyValue)}</span> al
              mes.
            </>
          ) : (
            'Lo que tienes sin alquilar.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SectionBody data={data} loading={loading} onRetry={onRetry} height="h-40">
          {(v) =>
            v.freeUnits === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No tienes trasteros libres.
              </p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="pb-1 font-normal">Tamaño</th>
                      <th className="pb-1 text-right font-normal">Libres</th>
                      <th className="pb-1 text-right font-normal">Al mes</th>
                      <th className="pb-1 text-right font-normal">Días libres</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {v.byType.map((t) => (
                      <tr key={t.unitTypeId}>
                        <td className="py-1.5">{t.name}</td>
                        <td className="py-1.5 text-right tabular-nums">{t.free}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {formatEur(t.monthlyValue)}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{t.avgDaysFree}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">Más tiempo sin alquilar</p>
                  <ul className="flex flex-wrap gap-1.5 text-xs">
                    {v.longestFree.map((u) => (
                      <li key={u.unitId}>
                        <Link
                          href={`/units/${u.unitId}`}
                          className="inline-block rounded-md border px-2 py-1 hover:bg-muted/50"
                        >
                          {u.code} · {u.days} días
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )
          }
        </SectionBody>
      </CardContent>
    </Card>
  );
}

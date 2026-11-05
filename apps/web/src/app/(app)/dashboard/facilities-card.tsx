'use client';

import Link from 'next/link';

import type { DashboardFacilityRowDto } from '@storageos/shared';

import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEur } from '@/lib/format';

function barColor(pct: number): string {
  if (pct >= 85) return '#16a34a';
  if (pct >= 60) return '#2563eb';
  if (pct >= 35) return '#eab308';
  return '#ef4444';
}

/** Cada local de un vistazo, para compararlos. */
export function FacilitiesCard({
  data,
  loading,
  onRetry,
}: {
  data: DashboardFacilityRowDto[] | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  // Con un solo local, todo esto ya está en las demás tarjetas.
  if (data && data.length < 2) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Por local</CardTitle>
        <CardDescription>Altas y bajas del periodo elegido.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <SectionBody data={data} loading={loading} onRetry={onRetry} height="h-40">
          {(rows) => (
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-normal">Local</th>
                  <th className="pb-2 font-normal">Ocupación</th>
                  <th className="pb-2 text-right font-normal">Cuotas al mes</th>
                  <th className="pb-2 text-right font-normal">Vencido</th>
                  <th className="pb-2 text-right font-normal">Altas</th>
                  <th className="pb-2 text-right font-normal">Bajas</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((f) => (
                  <tr key={f.facilityId}>
                    <td className="py-2 font-medium">
                      <Link href={`/facilities/${f.facilityId}`} className="hover:underline">
                        {f.name}
                      </Link>
                    </td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${f.occupancyPct}%`,
                              backgroundColor: barColor(f.occupancyPct),
                            }}
                          />
                        </div>
                        <span className="tabular-nums text-muted-foreground">
                          {Math.round(f.occupancyPct)}% · {f.occupiedUnits}/{f.totalUnits}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatEur(f.mrr)}</td>
                    <td
                      className={`py-2 text-right tabular-nums ${f.overdue > 0 ? 'text-red-600' : ''}`}
                    >
                      {formatEur(f.overdue)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{f.moveIns}</td>
                    <td className="py-2 text-right tabular-nums">{f.moveOuts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}

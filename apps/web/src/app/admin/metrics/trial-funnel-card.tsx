'use client';

import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTrialFunnel } from '@/lib/admin/business-hooks';

const pctText = (n: number | null) => (n === null ? '—' : `${Math.round(n)} %`);

/** Embudo de pruebas: altas → primer contrato → pagan, por mes de alta. */
export function TrialFunnelCard({ months }: { months: number }) {
  const q = useTrialFunnel(months);
  const d = q.data;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Embudo de pruebas</CardTitle>
        <p className="text-xs text-muted-foreground">
          Tenants dados de alta cada mes: cuántos firmaron su primer contrato con un inquilino y en
          qué acabó su prueba.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : d.totals.signups === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Sin altas en el periodo.</p>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Kpi label="Altas" value={String(d.totals.signups)} />
              <Kpi
                label="Firman su primer contrato"
                value={pctText(d.activationPct)}
                hint={`${d.totals.activated} tenants`}
              />
              <Kpi
                label="Pasan a pagar"
                value={pctText(d.conversionPct)}
                hint="de las pruebas terminadas"
              />
              <Kpi
                label="Días hasta pagar"
                value={d.avgDaysToPay === null ? '—' : `${d.avgDaysToPay} d`}
                hint="de media"
              />
            </div>

            <ul className="space-y-2 text-sm" aria-label="Resultado de las pruebas">
              {(
                [
                  ['Pagan un plan', d.totals.converted],
                  ['Pasaron a Free', d.totals.toFree],
                  ['Se dieron de baja', d.totals.churned],
                  ['Siguen en prueba', d.totals.inTrial],
                ] as const
              ).map(([label, n]) => (
                <li key={label} className="flex items-center gap-3">
                  <span className="w-40 shrink-0">{label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(n / d.totals.signups) * 100}%` }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                    {n}
                  </span>
                </li>
              ))}
            </ul>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Alta</th>
                    <th className="px-2 py-1 text-right font-medium">Altas</th>
                    <th className="px-2 py-1 text-right font-medium">Contrato</th>
                    <th className="px-2 py-1 text-right font-medium">Pagan</th>
                    <th className="px-2 py-1 text-right font-medium">Free</th>
                    <th className="px-2 py-1 text-right font-medium">Baja</th>
                    <th className="px-2 py-1 text-right font-medium">En prueba</th>
                    <th className="px-2 py-1 text-right font-medium">Conversión</th>
                  </tr>
                </thead>
                <tbody>
                  {d.cohorts
                    .filter((c) => c.signups > 0)
                    .reverse()
                    .map((c) => (
                      <tr key={c.month} className="border-t">
                        <td className="px-2 py-1 font-medium">{c.cohort}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{c.signups}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{c.activated}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{c.converted}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{c.toFree}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{c.churned}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{c.inTrial}</td>
                        <td className="px-2 py-1 text-right tabular-nums font-medium">
                          {pctText(c.conversionPct)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

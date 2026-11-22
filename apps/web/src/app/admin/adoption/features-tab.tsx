'use client';

import { Loader2 } from 'lucide-react';

import type { AdminAdoptionDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdoptionInsights } from '@/lib/admin/health-insights-hooks';
import { formatPct, plural } from '@/lib/format';

const num = (n: number) => n.toLocaleString('es-ES');

/**
 * Funciones: adopción e intensidad por función, matriz función × plan, bajas
 * de quien la usa frente a quien no y funciones que casi nadie usa.
 */
export function FeaturesTab({ adoption }: { adoption: AdminAdoptionDto }) {
  const q = useAdoptionInsights();

  return (
    <div className="space-y-6">
      <Card className="min-w-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Adopción e intensidad por función</CardTitle>
          <p className="text-xs text-muted-foreground">
            Tenants que la usan (verde) sobre los que la tienen en su plan o como extra, y cuánto se
            usó entre todos en los últimos 30 días donde hay registro (pasa el ratón por el nombre
            para ver cómo se mide).
          </p>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {adoption.featureAdoption.map((f) => {
            const pct = f.tenantsWithAccess > 0 ? (f.tenantsUsing / f.tenantsWithAccess) * 100 : 0;
            return (
              <div key={f.feature} className="flex min-w-0 flex-wrap items-center gap-x-3 text-sm">
                <span className="w-32 shrink-0 truncate sm:w-44" title={f.signal}>
                  {f.label}
                </span>
                <div className="h-2 min-w-[80px] flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-green-500"
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                  {f.tenantsUsing}/{f.tenantsWithAccess}
                </span>
                <span className="w-full text-xs text-muted-foreground sm:w-44 sm:text-right">
                  {f.uses30Total !== null && f.intensityUnit
                    ? `${num(f.uses30Total)} ${f.intensityUnit} en 30 días`
                    : 'por configuración'}
                </span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {q.isError ? (
        <AdminError onRetry={() => void q.refetch()} />
      ) : q.isLoading || !q.data ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Función × plan</CardTitle>
              <p className="text-xs text-muted-foreground">
                En cada plan: cuántos la usan de los que la tienen.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Función</th>
                    {q.data.plans.map((p) => (
                      <th key={p.slug} className="px-2 py-1.5 text-right font-medium">
                        {p.name}
                      </th>
                    ))}
                    <th className="px-2 py-1.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {q.data.matrix.map((r) => (
                    <tr key={r.feature}>
                      <td className="py-1.5 pr-3">{r.label}</td>
                      {q.data.plans.map((p) => {
                        const c = r.byPlan[p.slug];
                        return (
                          <td
                            key={p.slug}
                            className="px-2 py-1.5 text-right tabular-nums text-muted-foreground"
                          >
                            {c && c.withAccess + c.using > 0 ? `${c.using}/${c.withAccess}` : '—'}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                        {r.using}/{r.withAccess}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Bajas según el uso</CardTitle>
              <p className="text-xs text-muted-foreground">
                De los clientes que pagaron en los últimos 12 meses (
                {plural(q.data.churnedLast12m, 'baja', 'bajas')}), qué parte se dio de baja entre
                los que usaron cada función y entre los que no. Solo funciones con registro fechado;
                con pocos datos sale «poco histórico».
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Función</th>
                    <th className="px-2 py-1.5 text-right font-medium">La usaron</th>
                    <th className="px-2 py-1.5 text-right font-medium">No la usaron</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {q.data.retention
                    .filter((r) => r.usedCount + r.notUsedCount > 0)
                    .map((r) => (
                      <tr key={r.feature}>
                        <td className="py-1.5 pr-3">
                          {r.label}
                          {!r.enoughData && (
                            <span className="ml-1 text-xs italic text-muted-foreground">
                              poco histórico
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {r.usedChurnPct !== null ? formatPct(r.usedChurnPct) : '—'}
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({r.usedCount})
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {r.notUsedChurnPct !== null ? formatPct(r.notUsedChurnPct) : '—'}
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({r.notUsedCount})
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {q.data.retention.every((r) => r.usedCount + r.notUsedCount === 0) && (
                <p className="py-3 text-sm text-muted-foreground">
                  Aún no hay clientes que hayan pagado en los últimos 12 meses.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Funciones que casi nadie usa</CardTitle>
              <p className="text-xs text-muted-foreground">
                Las usa menos del 10 % de quien las tiene (o uno o ninguno): candidatas a
                explicarlas mejor, cambiarlas de plan o retirarlas.
              </p>
            </CardHeader>
            <CardContent>
              {q.data.rarelyUsed.length === 0 ? (
                <p className="text-sm text-muted-foreground">Todas se usan.</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {q.data.rarelyUsed.map((f) => (
                    <li
                      key={f.feature}
                      className="rounded-md border px-2 py-1 text-xs text-muted-foreground"
                    >
                      <span className="font-medium text-foreground">{f.label}</span> · {f.using} de{' '}
                      {f.withAccess}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

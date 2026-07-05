'use client';

import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminLtv } from '@/lib/admin/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/** Color de la celda de ingreso/tenant de una cohorte (más ingreso → más verde). */
function cellStyle(value: number, max: number): { className: string } {
  if (max <= 0 || value <= 0) return { className: 'bg-muted/40 text-muted-foreground' };
  const ratio = value / max;
  if (ratio >= 0.8) return { className: 'bg-green-600 text-white' };
  if (ratio >= 0.6) return { className: 'bg-green-500 text-white' };
  if (ratio >= 0.4) return { className: 'bg-green-400 text-green-950' };
  if (ratio >= 0.2) return { className: 'bg-green-300 text-green-950' };
  return { className: 'bg-green-200 text-green-950' };
}

export function LtvCard() {
  const q = useAdminLtv();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">LTV y cohortes de ingresos</CardTitle>
        <p className="text-xs text-muted-foreground">
          Valor de vida del cliente (a partir de los pagos de suscripción) e ingreso acumulado por
          mes de alta.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !q.data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : q.data.payingTenants === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Aún no hay pagos de suscripción para calcular el LTV.
          </p>
        ) : (
          <div className="space-y-5">
            {/* KPIs */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Kpi label="LTV medio" value={eur(q.data.avgLtv)} hint="modelo" />
              <Kpi label="LTV realizado" value={eur(q.data.realizedLtv)} hint="ya cobrado" />
              <Kpi
                label="Vida media"
                value={`${q.data.avgLifespanMonths.toFixed(1)} m`}
                hint={`${q.data.payingTenants} cuentas`}
              />
              <Kpi label="ARPA" value={eur(q.data.avgArpa)} hint="ingreso/mes" />
            </div>

            {/* Cohortes de ingresos */}
            <div>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                Ingreso acumulado por cohorte de alta
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-1 text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="px-2 py-1 text-left font-medium">Cohorte</th>
                      <th className="px-2 py-1 text-right font-medium">Altas</th>
                      <th className="px-2 py-1 text-right font-medium">Ingreso</th>
                      <th className="px-2 py-1 text-right font-medium">Ingreso/tenant</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const maxPerTenant = Math.max(
                        ...q.data.cohorts.map((c) => c.revenuePerTenant),
                        0,
                      );
                      return q.data.cohorts.map((c) => {
                        const s = cellStyle(c.revenuePerTenant, maxPerTenant);
                        return (
                          <tr key={c.cohortMonth}>
                            <td className="whitespace-nowrap px-2 py-1 font-medium">
                              {c.cohortMonth}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                              {c.tenants}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums">{eur(c.revenue)}</td>
                            <td
                              className={`rounded px-2 py-1 text-right tabular-nums ${s.className}`}
                            >
                              {eur(c.revenuePerTenant)}
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Top tenants por LTV realizado */}
            {q.data.topTenants.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                  Top clientes por valor cobrado
                </h3>
                <ul className="space-y-1 text-sm">
                  {q.data.topTenants.map((t) => (
                    <li
                      key={t.tenantId}
                      className="flex items-center justify-between gap-2 border-b border-border/50 pb-1 last:border-0"
                    >
                      <span className="truncate">{t.name}</span>
                      <span className="shrink-0 tabular-nums">
                        {eur(t.totalPaid)}{' '}
                        <span className="text-xs text-muted-foreground">
                          ({t.paymentsCount} pagos)
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

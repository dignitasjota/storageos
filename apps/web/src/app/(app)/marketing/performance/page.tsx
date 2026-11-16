'use client';

import { MARKETING_CHANNEL_TYPE_LABELS, type MarketingPerformanceRowDto } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { AdsPerformanceCard } from './ads-card';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { localDateString, localMonthStart } from '@/lib/dates';
import { useMarketingPerformance } from '@/lib/marketing/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

function monthRange(monthsBack: number): { from: string; to: string } {
  const now = new Date();
  const from = localMonthStart(monthsBack - 1, now);
  const to = localDateString(now);
  return { from, to };
}

const PERIODS = [
  { label: 'Este mes', months: 1 },
  { label: 'Últimos 3 meses', months: 3 },
  { label: 'Últimos 6 meses', months: 6 },
  { label: 'Últimos 12 meses', months: 12 },
];

/** Verde si un cliente devuelve 3 veces su coste en un año; ámbar, si al menos lo cubre. */
function ratioColor(row: MarketingPerformanceRowDto): string {
  if (row.cac == null || row.cac <= 0 || row.liveCount === 0 || row.mrrGenerated <= 0) return '';
  const mrrPerCustomer = row.mrrGenerated / row.liveCount;
  const ltvToCac = (mrrPerCustomer * 12) / row.cac;
  if (ltvToCac >= 3) return 'text-emerald-600 dark:text-emerald-400';
  if (ltvToCac >= 1) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

export default function MarketingPerformancePage() {
  const [monthsBack, setMonthsBack] = useState(3);
  const [range, setRange] = useState(() => monthRange(3));

  function selectPeriod(months: number) {
    setMonthsBack(months);
    setRange(monthRange(months));
  }

  const performance = useMarketingPerformance(range);
  const data = performance.data;
  const rows = data?.rows ?? [];
  const totals = data?.totals;
  const seeCost = data?.money.cost ?? false;
  const seeRevenue = data?.money.revenue ?? false;
  const unassigned = data?.unassignedCost ?? 0;
  const moneyCols = (seeCost ? 3 : 0) + (seeRevenue ? 1 : 0) + (seeCost && seeRevenue ? 1 : 0);

  return (
    <div className="space-y-6 px-4 py-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rendimiento de marketing</h1>
          <p className="text-sm text-muted-foreground">
            Lo que cuesta cada canal frente a los contactos y los clientes que trae.
          </p>
        </div>
        <div
          className="flex flex-wrap gap-1 rounded-md border p-1"
          role="group"
          aria-label="Periodo"
        >
          {PERIODS.map((p) => (
            <button
              key={p.months}
              type="button"
              aria-pressed={monthsBack === p.months}
              onClick={() => selectPeriod(p.months)}
              className={`h-9 whitespace-nowrap rounded px-3 text-xs font-medium transition-colors ${
                monthsBack === p.months
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {totals && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {seeCost && (
            <Kpi
              label="Coste de los canales"
              value={eur(totals.cost)}
              {...(unassigned > 0 ? { hint: `Y ${eur(unassigned)} de marketing sin canal` } : {})}
            />
          )}
          <Kpi label="Contactos" value={String(totals.leadsCount)} />
          <Kpi label="Clientes" value={String(totals.wonCount)} hint="Contratos firmados" />
          {seeRevenue && (
            <Kpi
              label="Cuota al mes"
              value={eur(totals.mrrGenerated)}
              hint="De los clientes que siguen"
            />
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Por canal</CardTitle>
        </CardHeader>
        <CardContent>
          {performance.isError ? (
            <SectionError onRetry={() => void performance.refetch()} />
          ) : performance.isLoading ? (
            <div className="flex justify-center py-10" role="status" aria-label="Cargando">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 && unassigned === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Sin datos en este periodo. Vincula los gastos de categoría «Marketing» a un canal para
              ver su coste aquí.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Canal</th>
                    <th className="px-2 py-2 font-medium">Tipo</th>
                    {seeCost && <th className="px-2 py-2 text-right font-medium">Coste</th>}
                    <th className="px-2 py-2 text-right font-medium">Contactos</th>
                    <th className="px-2 py-2 text-right font-medium">Clientes</th>
                    {seeCost && (
                      <>
                        <th className="px-2 py-2 text-right font-medium">Coste/contacto</th>
                        <th className="px-2 py-2 text-right font-medium">Coste/cliente</th>
                      </>
                    )}
                    {seeRevenue && (
                      <th className="px-2 py-2 text-right font-medium">Cuota al mes</th>
                    )}
                    {seeCost && seeRevenue && (
                      <th className="px-2 py-2 text-right font-medium">Payback (meses)</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.channelId} className="border-b last:border-0">
                      <td className="px-2 py-2 font-medium">
                        {row.channelName}
                        {row.deleted && (
                          <Badge variant="outline" className="ml-2 font-normal">
                            borrado
                          </Badge>
                        )}
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">
                        {MARKETING_CHANNEL_TYPE_LABELS[row.type]}
                      </td>
                      {seeCost && <td className="px-2 py-2 text-right">{eur(row.cost)}</td>}
                      <td className="px-2 py-2 text-right">{row.leadsCount}</td>
                      <td className="px-2 py-2 text-right">
                        {row.wonCount}
                        {row.wonCount > row.liveCount && (
                          <span className="block text-xs text-muted-foreground">
                            siguen {row.liveCount}
                          </span>
                        )}
                      </td>
                      {seeCost && (
                        <>
                          <td className="px-2 py-2 text-right">
                            {row.costPerLead != null ? eur(row.costPerLead) : '—'}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {row.cac != null ? eur(row.cac) : '—'}
                          </td>
                        </>
                      )}
                      {seeRevenue && (
                        <td className="px-2 py-2 text-right">{eur(row.mrrGenerated)}</td>
                      )}
                      {seeCost && seeRevenue && (
                        <td className={`px-2 py-2 text-right font-medium ${ratioColor(row)}`}>
                          {row.paybackMonths != null
                            ? row.paybackMonths.toLocaleString('es-ES', {
                                maximumFractionDigits: 1,
                              })
                            : '—'}
                        </td>
                      )}
                    </tr>
                  ))}
                  {seeCost && unassigned > 0 && (
                    <tr className="border-b text-muted-foreground last:border-0">
                      <td className="px-2 py-2" colSpan={2}>
                        Marketing sin canal
                      </td>
                      <td className="px-2 py-2 text-right">{eur(unassigned)}</td>
                      <td className="px-2 py-2" colSpan={2 + moneyCols - 1} />
                    </tr>
                  )}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t font-medium">
                      <td className="px-2 py-2" colSpan={2}>
                        Total
                      </td>
                      {seeCost && <td className="px-2 py-2 text-right">{eur(totals.cost)}</td>}
                      <td className="px-2 py-2 text-right">{totals.leadsCount}</td>
                      <td className="px-2 py-2 text-right">{totals.wonCount}</td>
                      {seeCost && <td className="px-2 py-2" colSpan={2} />}
                      {seeRevenue && (
                        <td className="px-2 py-2 text-right">{eur(totals.mrrGenerated)}</td>
                      )}
                      {seeCost && seeRevenue && <td className="px-2 py-2" />}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <AdsPerformanceCard range={range} />

      <p className="text-xs text-muted-foreground">
        Los <strong>contactos</strong> son los que llegaron en el periodo con el origen del canal;
        los <strong>clientes</strong>, los contratos firmados en el periodo de esos contactos (o con
        la promoción del canal). El <strong>coste por cliente</strong> sale de los gastos vinculados
        al canal, y el <strong>payback</strong> son los meses de cuota que tarda un cliente de ese
        canal en cubrir lo que costó conseguirlo: cuanto más bajo, mejor.
      </p>
    </div>
  );
}

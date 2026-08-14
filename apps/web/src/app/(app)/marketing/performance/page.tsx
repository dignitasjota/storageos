'use client';

import { MARKETING_CHANNEL_TYPE_LABELS, type MarketingPerformanceRowDto } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMarketingPerformance } from '@/lib/marketing/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

function monthRange(monthsBack: number): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1))
    .toISOString()
    .slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

const PERIODS = [
  { label: 'Este mes', months: 1 },
  { label: 'Últimos 3 meses', months: 3 },
  { label: 'Últimos 6 meses', months: 6 },
  { label: 'Últimos 12 meses', months: 12 },
];

function ratioColor(row: MarketingPerformanceRowDto): string {
  if (row.cac == null || row.mrrGenerated <= 0 || row.wonCount === 0) return '';
  const mrrPerCustomer = row.mrrGenerated / row.wonCount;
  if (mrrPerCustomer <= 0) return '';
  const ltvToCac = (mrrPerCustomer * 12) / row.cac;
  if (ltvToCac >= 3) return 'text-emerald-600 dark:text-emerald-400';
  if (ltvToCac >= 1) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

export default function MarketingPerformancePage() {
  const [monthsBack, setMonthsBack] = useState(3);
  const [range, setRange] = useState(() => monthRange(3));

  function selectPeriod(months: number) {
    setMonthsBack(months);
    setRange(monthRange(months));
  }

  const performance = useMarketingPerformance(range);
  const rows = performance.data?.rows ?? [];
  const totals = performance.data?.totals;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rendimiento de marketing</h1>
          <p className="text-sm text-muted-foreground">
            Coste por canal frente a leads, conversiones y MRR generado.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border p-1">
          {PERIODS.map((p) => (
            <button
              key={p.months}
              type="button"
              onClick={() => selectPeriod(p.months)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
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
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Coste total
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{eur(totals.cost)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Leads</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{totals.leadsCount}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Convertidos
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{totals.wonCount}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                MRR generado
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{eur(totals.mrrGenerated)}</CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Por canal</CardTitle>
        </CardHeader>
        <CardContent>
          {performance.isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Sin datos en este periodo. Vincula gastos de categoría «Marketing» a un canal para ver
              su coste aquí.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Canal</th>
                    <th className="px-2 py-2 font-medium">Tipo</th>
                    <th className="px-2 py-2 text-right font-medium">Coste</th>
                    <th className="px-2 py-2 text-right font-medium">Leads</th>
                    <th className="px-2 py-2 text-right font-medium">Ganados</th>
                    <th className="px-2 py-2 text-right font-medium">Coste/lead</th>
                    <th className="px-2 py-2 text-right font-medium">CAC</th>
                    <th className="px-2 py-2 text-right font-medium">MRR generado</th>
                    <th className="px-2 py-2 text-right font-medium">Payback (meses)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.channelId} className="border-b last:border-0">
                      <td className="px-2 py-2 font-medium">{row.channelName}</td>
                      <td className="px-2 py-2 text-muted-foreground">
                        {MARKETING_CHANNEL_TYPE_LABELS[row.type]}
                      </td>
                      <td className="px-2 py-2 text-right">{eur(row.cost)}</td>
                      <td className="px-2 py-2 text-right">{row.leadsCount}</td>
                      <td className="px-2 py-2 text-right">{row.wonCount}</td>
                      <td className="px-2 py-2 text-right">
                        {row.costPerLead != null ? eur(row.costPerLead) : '—'}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {row.cac != null ? eur(row.cac) : '—'}
                      </td>
                      <td className="px-2 py-2 text-right">{eur(row.mrrGenerated)}</td>
                      <td className={`px-2 py-2 text-right font-medium ${ratioColor(row)}`}>
                        {row.paybackMonths != null ? row.paybackMonths.toFixed(1) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t font-medium">
                      <td className="px-2 py-2" colSpan={2}>
                        Total
                      </td>
                      <td className="px-2 py-2 text-right">{eur(totals.cost)}</td>
                      <td className="px-2 py-2 text-right">{totals.leadsCount}</td>
                      <td className="px-2 py-2 text-right">{totals.wonCount}</td>
                      <td className="px-2 py-2 text-right" colSpan={2} />
                      <td className="px-2 py-2 text-right">{eur(totals.mrrGenerated)}</td>
                      <td className="px-2 py-2 text-right" />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        El <strong>coste por lead</strong> y el <strong>CAC</strong> (coste de adquisición) se
        calculan sobre los gastos vinculados al canal en el periodo. El <strong>payback</strong> son
        los meses de cuota que tarda un cliente medio de ese canal en cubrir su coste de adquisición
        — cuanto más bajo, mejor.
      </p>
    </div>
  );
}

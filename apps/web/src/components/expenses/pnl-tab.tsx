'use client';

import {
  PROFIT_LOSS_ALLOCATION_LABELS,
  ProfitLossAllocationEnum,
  type ProfitLossAllocation,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { eur } from './fields';

import { SectionError } from '@/components/dashboard/section-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProfitLoss, useProfitLossMonthly } from '@/lib/expenses/hooks';
import { formatDate, formatEurShort } from '@/lib/format';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

/** Doce meses que acaban en el mes de `to`. */
function yearUntil(to: string): string {
  const d = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return d.toISOString().slice(0, 10);
}

/** Variación frente al periodo anterior; `higherIsBetter` decide el color. */
function Delta({
  now,
  before,
  higherIsBetter,
}: {
  now: number;
  before: number;
  higherIsBetter: boolean;
}) {
  if (before === 0 && now === 0) return null;
  if (before === 0) return <span className="text-xs text-muted-foreground">sin datos antes</span>;
  const pct = ((now - before) / Math.abs(before)) * 100;
  if (Math.abs(pct) < 0.5) return <span className="text-xs text-muted-foreground">= igual</span>;
  const good = pct > 0 === higherIsBetter;
  return (
    <span
      className={`text-xs ${good ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}
    >
      {pct > 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(0)} %
    </span>
  );
}

export function PnlTab({ from, to }: { from: string; to: string }) {
  const [allocation, setAllocation] = useState<ProfitLossAllocation>('none');
  const pnl = useProfitLoss(from, to, allocation);
  const monthly = useProfitLossMonthly(yearUntil(to), to);
  const data = pnl.data;
  const invoicesVisible = data?.invoicesVisible ?? true;
  const paymentsVisible = data?.paymentsVisible ?? true;
  const showShare = allocation !== 'none';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Cuenta de resultados por local</CardTitle>
              <p className="text-xs text-muted-foreground">
                Facturado sin IVA, igual que en el Resumen (una sustitutiva cuenta solo la
                diferencia y los abonos restan). Gastos: lo que cuestan (sin el IVA que se deduce).
                Cobrado: el dinero recibido, IVA incluido.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Gastos generales</span>
              <Select
                value={allocation}
                onValueChange={(v) => setAllocation(v as ProfitLossAllocation)}
              >
                <SelectTrigger className="h-8 w-48 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ProfitLossAllocationEnum.options.map((a) => (
                    <SelectItem key={a} value={a}>
                      {PROFIT_LOSS_ALLOCATION_LABELS[a]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {pnl.isLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : pnl.isError || !data ? (
            <SectionError onRetry={() => void pnl.refetch()} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {invoicesVisible && (
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">Facturado (sin IVA)</div>
                    <div className="text-lg font-semibold tabular-nums">
                      {eur(data.totals.invoiced)}
                    </div>
                    <Delta
                      now={data.totals.invoiced}
                      before={data.previous.invoiced}
                      higherIsBetter
                    />
                  </div>
                )}
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Gastos</div>
                  <div className="text-lg font-semibold tabular-nums">
                    {eur(data.totals.expenses)}
                  </div>
                  <Delta
                    now={data.totals.expenses}
                    before={data.previous.expenses}
                    higherIsBetter={false}
                  />
                </div>
                {invoicesVisible && (
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">Resultado</div>
                    <div
                      className={`text-lg font-semibold tabular-nums ${data.totals.net >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}
                    >
                      {eur(data.totals.net)}
                    </div>
                    <Delta now={data.totals.net} before={data.previous.net} higherIsBetter />
                  </div>
                )}
                {invoicesVisible && (
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">Margen</div>
                    <div className="text-lg font-semibold tabular-nums">
                      {data.totals.invoiced > 0
                        ? `${((data.totals.net / data.totals.invoiced) * 100).toFixed(1)} %`
                        : '—'}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      frente a {formatDate(data.previous.from)} – {formatDate(data.previous.to)}
                    </span>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="p-2">Local</th>
                      {invoicesVisible && <th className="p-2 text-right">Facturado</th>}
                      {paymentsVisible && <th className="p-2 text-right">Cobrado</th>}
                      <th className="p-2 text-right">Gastos</th>
                      {showShare && <th className="p-2 text-right">Parte de los generales</th>}
                      {invoicesVisible && <th className="p-2 text-right">Resultado</th>}
                      {invoicesVisible && <th className="p-2 text-right">Margen</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.facilityId ?? 'none'} className="border-t">
                        <td className="p-2">{r.facilityName}</td>
                        {invoicesVisible && (
                          <td className="p-2 text-right tabular-nums">{eur(r.invoiced)}</td>
                        )}
                        {paymentsVisible && (
                          <td className="p-2 text-right tabular-nums text-muted-foreground">
                            {eur(r.collected)}
                          </td>
                        )}
                        <td className="p-2 text-right tabular-nums text-muted-foreground">
                          {eur(r.expenses)}
                        </td>
                        {showShare && (
                          <td className="p-2 text-right tabular-nums text-muted-foreground">
                            {r.facilityId ? eur(r.allocatedGeneral) : '—'}
                          </td>
                        )}
                        {invoicesVisible && (
                          <td
                            className={`p-2 text-right font-semibold tabular-nums ${r.net >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}
                          >
                            {eur(r.net)}
                          </td>
                        )}
                        {invoicesVisible && (
                          <td className="p-2 text-right tabular-nums text-muted-foreground">
                            {r.margin === null ? '—' : `${r.margin.toFixed(1)} %`}
                          </td>
                        )}
                      </tr>
                    ))}
                    {data.rows.length === 0 && (
                      <tr>
                        <td colSpan={7} className="p-6 text-center text-muted-foreground">
                          Sin movimientos en este periodo.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {data.byCategory.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Gastos por categoría (y su presupuesto del periodo)
                  </p>
                  <ul className="space-y-2">
                    {data.byCategory.map((c) => {
                      const over = c.budget !== null && c.amount > c.budget;
                      const pct =
                        c.budget && c.budget > 0
                          ? Math.min(100, (c.amount / c.budget) * 100)
                          : null;
                      return (
                        <li key={c.category} className="text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span>{c.label}</span>
                            <span className="tabular-nums">
                              {eur(c.amount)}
                              {c.budget !== null && (
                                <span
                                  className={`ml-1 text-xs ${over ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground'}`}
                                >
                                  de {eur(c.budget)}
                                </span>
                              )}
                            </span>
                          </div>
                          {pct !== null && (
                            <div className="mt-1 h-1.5 rounded-full bg-muted">
                              <div
                                className={`h-1.5 rounded-full ${over ? 'bg-red-600' : 'bg-primary'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Mes a mes (doce meses)</CardTitle>
        </CardHeader>
        <CardContent>
          {monthly.isLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : monthly.isError || !monthly.data ? (
            <SectionError onRetry={() => void monthly.refetch()} />
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 300, height: 256 }}
              >
                <ComposedChart
                  data={monthly.data.months.map((m) => ({ ...m, label: monthLabel(m.month) }))}
                  margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="hsl(var(--border))"
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={formatEurShort}
                    tick={{ fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={72}
                  />
                  <Tooltip
                    formatter={(v) => eur(Number(v) || 0)}
                    labelClassName="font-medium"
                    contentStyle={{ fontSize: 13 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {monthly.data.invoicesVisible && (
                    <Bar dataKey="invoiced" name="Facturado" fill="#2563eb" radius={[4, 4, 0, 0]} />
                  )}
                  <Bar dataKey="expenses" name="Gastos" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                  {monthly.data.invoicesVisible && (
                    <Line
                      dataKey="net"
                      name="Resultado"
                      type="linear"
                      stroke="hsl(var(--foreground))"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

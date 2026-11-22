'use client';

import { Loader2 } from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminMrrMovements } from '@/lib/admin/hooks';
import { formatEur, formatPct } from '@/lib/format';

export function MrrMovementsCard({ months = 12 }: { months?: number }) {
  const q = useAdminMrrMovements(months);

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Movimientos de MRR</CardTitle>
        <p className="text-xs text-muted-foreground">
          Nuevo, expansión y reactivación (suman) vs. contracción y baja (restan) por mes, sin IVA.
          Línea = Net New MRR. El pago atrasado no cuenta como baja.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !q.data ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : q.data.warmingUp ? (
          <p className="py-6 text-sm text-muted-foreground">
            Aún no hay histórico de MRR suficiente. Los movimientos se irán poblando con los cierres
            mensuales (y con el histórico de pagos cuando haya cobros de suscripción).
          </p>
        ) : (
          (() => {
            const data = q.data.months.map((m) => ({
              label: m.label,
              new: m.newMrr,
              expansion: m.expansion,
              reactivation: m.reactivation,
              contraction: -m.contraction,
              churn: -m.churn,
              net: m.net,
            }));
            const last = q.data.months[q.data.months.length - 1];
            return (
              <div className="space-y-3">
                {last && (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Kpi label="Net New (último mes)" value={formatEur(last.net)} />
                    <Kpi
                      label="NRR (último mes)"
                      value={last.nrr !== null ? formatPct(last.nrr, 0) : '—'}
                    />
                    <Kpi
                      label="Expansión"
                      value={formatEur(last.expansion)}
                      accent="text-green-600"
                    />
                    <Kpi
                      label="Baja (churn)"
                      value={formatEur(-last.churn)}
                      accent="text-red-600"
                    />
                  </div>
                )}
                <div className="h-72 w-full">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    initialDimension={{ width: 300, height: 288 }}
                  >
                    <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <ReferenceLine y={0} stroke="currentColor" className="text-border" />
                      <Tooltip
                        formatter={(value, name) => `${String(name)}: ${formatEur(Number(value))}`}
                        labelClassName="text-xs"
                        contentStyle={{ fontSize: 12 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="new" name="Nuevo" stackId="m" fill="#16a34a" />
                      <Bar dataKey="expansion" name="Expansión" stackId="m" fill="#4ade80" />
                      <Bar dataKey="reactivation" name="Reactivación" stackId="m" fill="#0ea5e9" />
                      <Bar dataKey="contraction" name="Contracción" stackId="m" fill="#f59e0b" />
                      <Bar dataKey="churn" name="Baja" stackId="m" fill="#ef4444" />
                      <Line
                        type="monotone"
                        dataKey="net"
                        name="Net New"
                        stroke="#111827"
                        strokeWidth={2}
                        dot={{ r: 2 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            );
          })()
        )}
      </CardContent>
    </Card>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${accent ?? ''}`}>{value}</div>
    </div>
  );
}

'use client';

import { CLIENT_STATE_LABELS } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
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

import type { AdminClientState } from '@storageos/shared';

import {
  annotationLines,
  useAnnotationsByLabel,
} from '@/components/admin/metrics/annotation-lines';
import { useOpenBreakdown } from '@/components/admin/metrics/breakdown-sheet';
import { CsvButton } from '@/components/admin/metrics/csv-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useClientStates } from '@/lib/admin/metrics-insights-hooks';
import { formatEur, formatEurShort } from '@/lib/format';

const COLORS: Record<AdminClientState, string> = {
  trial: '#eab308',
  paying: '#16a34a',
  past_due: '#dc2626',
  read_only: '#a855f7',
  churned: '#64748b',
  free: '#06b6d4',
};

const MRR_HINT = {
  real: 'aportan',
  potential: 'pagarían',
  lost: 'se perdió',
} as const;

/** Qué cifra del desglose abre cada estado. */
const BREAKDOWN: Record<AdminClientState, string> = {
  trial: 'trial',
  paying: 'paying',
  past_due: 'past_due',
  read_only: 'read_only',
  churned: 'churned',
  free: 'free',
};

/**
 * Clientes por estado con su MRR y la evolución mes a mes. La retención y el
 * churn son de clientes que pagan; cuántas pruebas pasan a pagar está en el
 * embudo de pruebas.
 */
export function ClientStatesCard({ months }: { months: number }) {
  const q = useClientStates(months);
  const open = useOpenBreakdown();
  const notes = useAnnotationsByLabel();
  const d = q.data;
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">Estados de cliente</CardTitle>
          <CsvButton
            filename="estados-de-cliente.csv"
            disabled={!d}
            rows={() => [
              [
                'Mes',
                'En prueba',
                'Pagando',
                'Pago atrasado',
                'Solo lectura',
                'De baja (acumulado)',
                'MRR de quien paga sin IVA',
              ],
              ...(d?.evolution ?? []).map((e) => [
                e.label,
                e.trial,
                e.paying,
                e.pastDue,
                e.readOnly,
                e.churned,
                e.payingMrr,
              ]),
            ]}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          MRR sin IVA: lo que aportan (pagando y atrasados), lo que pagarían (prueba y solo lectura)
          o lo que se perdió (de baja). La retención y el churn de esta página son de clientes que
          pagan; cuántas pruebas pasan a pagar, en el{' '}
          <Link href="#embudo-pruebas" className="underline">
            embudo de pruebas
          </Link>
          .
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {d.states.map((s) => (
                <button
                  key={s.state}
                  type="button"
                  onClick={() => open({ metric: BREAKDOWN[s.state] })}
                  className="min-w-0 rounded-lg border p-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: COLORS[s.state] }}
                    />
                    <span className="truncate">{CLIENT_STATE_LABELS[s.state]}</span>
                  </span>
                  <span className="block text-xl font-semibold tabular-nums">{s.count}</span>
                  {s.state !== 'free' && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {formatEur(s.mrr)} {MRR_HINT[s.mrrKind]}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 300, height: 256 }}
              >
                <ComposedChart data={d.evolution} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
                  <YAxis
                    yAxisId="n"
                    allowDecimals={false}
                    tick={{ fontSize: 11 }}
                    width={28}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="eur"
                    orientation="right"
                    tick={{ fontSize: 11 }}
                    width={48}
                    tickFormatter={(v) => formatEurShort(Number(v))}
                    tickLine={false}
                  />
                  <Tooltip
                    formatter={(v, name) =>
                      name === 'MRR de quien paga' ? formatEur(Number(v)) : String(v)
                    }
                    contentStyle={{ borderRadius: 8, fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {annotationLines(
                    notes,
                    d.evolution.map((e) => e.label),
                  )}
                  <Bar
                    yAxisId="n"
                    dataKey="paying"
                    name="Pagando"
                    stackId="s"
                    fill={COLORS.paying}
                  />
                  <Bar
                    yAxisId="n"
                    dataKey="pastDue"
                    name="Pago atrasado"
                    stackId="s"
                    fill={COLORS.past_due}
                  />
                  <Bar
                    yAxisId="n"
                    dataKey="trial"
                    name="En prueba"
                    stackId="s"
                    fill={COLORS.trial}
                  />
                  <Bar
                    yAxisId="n"
                    dataKey="readOnly"
                    name="Solo lectura"
                    stackId="s"
                    fill={COLORS.read_only}
                  />
                  <Line
                    yAxisId="n"
                    type="monotone"
                    dataKey="churned"
                    name="De baja (acumulado)"
                    stroke={COLORS.churned}
                    strokeDasharray="4 3"
                    dot={false}
                  />
                  <Line
                    yAxisId="eur"
                    type="monotone"
                    dataKey="payingMrr"
                    name="MRR de quien paga"
                    stroke="hsl(var(--foreground))"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

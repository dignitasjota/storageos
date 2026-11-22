'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { AdminRevenueSeriesBy } from '@storageos/shared';

import {
  annotationLines,
  useAnnotationsByLabel,
} from '@/components/admin/metrics/annotation-lines';
import { useOpenBreakdown } from '@/components/admin/metrics/breakdown-sheet';
import { CsvButton } from '@/components/admin/metrics/csv-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRevenueSeries } from '@/lib/admin/metrics-insights-hooks';
import { formatEur, formatEurShort } from '@/lib/format';

const BY_LABELS: Record<AdminRevenueSeriesBy, string> = {
  plan: 'Por plan',
  addon: 'Por extra',
  source: 'Por forma de cobro',
  rep: 'Por comercial',
};

/** Paleta categórica fija (en orden); a partir de la octava serie se repite. */
const PALETTE = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#a855f7',
  '#e0457b',
  '#0891b2',
  '#64748b',
];

/** Ingresos mes a mes por plan, extra, forma de cobro o comercial. */
export function RevenueSeriesCard({ months }: { months: number }) {
  const [by, setBy] = useState<AdminRevenueSeriesBy>('plan');
  const q = useRevenueSeries(by, months);
  const notes = useAnnotationsByLabel();
  const open = useOpenBreakdown();
  const d = q.data;
  const data =
    d?.labels.map((label, i) => {
      const row: Record<string, string | number> = { label };
      for (const s of d.series) row[s.key] = s.values[i] ?? 0;
      return row;
    }) ?? [];
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">Ingresos en el tiempo</CardTitle>
          <div className="flex items-center gap-1">
            <Select value={by} onValueChange={(v) => setBy(v as AdminRevenueSeriesBy)}>
              <SelectTrigger className="h-8 w-48" aria-label="Agrupar">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(BY_LABELS) as AdminRevenueSeriesBy[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {BY_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <CsvButton
              filename={`ingresos-${by}.csv`}
              disabled={!d}
              rows={() => [
                ['Serie', ...(d?.labels ?? [])],
                ...(d?.series ?? []).map((s) => [s.label, ...s.values]),
              ]}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {d?.note ?? ' '}
          {by === 'plan' && ' Pulsa una barra para ver los clientes de ese plan hoy.'}
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : d.series.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Sin ingresos en el periodo.</p>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 288 }}
            >
              <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  width={52}
                  tickFormatter={(v) => formatEurShort(Number(v))}
                  tickLine={false}
                />
                <Tooltip
                  formatter={(v) => formatEur(Number(v) || 0)}
                  contentStyle={{ borderRadius: 8, fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {annotationLines(notes, d.labels)}
                {d.series.map((s, i) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    stackId="r"
                    fill={PALETTE[i % PALETTE.length]}
                    stroke="hsl(var(--background))"
                    strokeWidth={1}
                    className={by === 'plan' ? 'cursor-pointer' : undefined}
                    onClick={
                      by === 'plan' ? () => open({ metric: 'plan', plan: s.key }) : undefined
                    }
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

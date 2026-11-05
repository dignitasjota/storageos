'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { ReceivablesDto } from '@storageos/shared';

import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEur as eur, formatEurShort as eurShort } from '@/lib/format';

const RANGE_LABELS: Record<string, string> = {
  '0-30': '0-30 días',
  '30-60': '30-60 días',
  '60-90': '60-90 días',
  '+90': '+90 días',
};
const RANGE_COLORS: Record<string, string> = {
  '0-30': '#eab308',
  '30-60': '#f97316',
  '60-90': '#ef4444',
  '+90': '#dc2626',
};

export function AgingCard({
  data,
  loading,
  onRetry,
}: {
  data: ReceivablesDto | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  const buckets = (data?.buckets ?? []).map((b) => ({
    ...b,
    label: RANGE_LABELS[b.range] ?? b.range,
    color: RANGE_COLORS[b.range] ?? '#94a3b8',
  }));
  const total = data?.overdue ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Morosidad por antigüedad</CardTitle>
        <CardDescription>
          {total > 0 ? (
            <>
              Total vencido <span className="font-medium text-foreground">{eur(total)}</span>
            </>
          ) : (
            'Importe vencido por tramo de días.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SectionBody data={data} loading={loading} onRetry={onRetry}>
          {() =>
            total === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Sin importes vencidos. 🎉
              </p>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  initialDimension={{ width: 300, height: 256 }}
                >
                  <BarChart data={buckets} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tickFormatter={eurShort}
                      tick={{ fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                      width={56}
                    />
                    <Tooltip
                      formatter={(v) => eur(Number(v) || 0)}
                      contentStyle={{ fontSize: 13 }}
                    />
                    <Bar dataKey="amount" name="Pendiente" radius={[4, 4, 0, 0]}>
                      {buckets.map((b) => (
                        <Cell key={b.range} fill={b.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )
          }
        </SectionBody>
      </CardContent>
    </Card>
  );
}

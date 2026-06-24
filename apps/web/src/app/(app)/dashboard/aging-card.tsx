'use client';

import { Loader2 } from 'lucide-react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAging } from '@/lib/analytics/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const eurShort = (n: number) =>
  n >= 1000 ? `${Math.round(n / 100) / 10}k €` : `${Math.round(n)} €`;

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

export function AgingCard() {
  const q = useAging();

  const buckets = (q.data?.buckets ?? []).map((b) => ({
    ...b,
    label: RANGE_LABELS[b.range] ?? b.range,
    color: RANGE_COLORS[b.range] ?? '#94a3b8',
  }));
  const total = q.data?.totalOutstanding ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Morosidad por antigüedad</CardTitle>
        <CardDescription>
          {total > 0 ? (
            <>
              Total pendiente <span className="font-medium text-foreground">{eur(total)}</span>
            </>
          ) : (
            'Importe vencido por tramo de días.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : total === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Sin importes vencidos. 🎉
          </p>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={buckets} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                <YAxis
                  tickFormatter={eurShort}
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                />
                <Tooltip
                  formatter={(v) => eur(Number(v) || 0)}
                  contentStyle={{ borderRadius: 8, fontSize: 13 }}
                />
                <Bar dataKey="amount" name="Pendiente" radius={[4, 4, 0, 0]}>
                  {buckets.map((b) => (
                    <Cell key={b.range} fill={b.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

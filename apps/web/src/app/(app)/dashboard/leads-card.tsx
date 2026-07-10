'use client';

import { Loader2 } from 'lucide-react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useLeadsFunnel } from '@/lib/analytics/hooks';

const pct = (n: number) => `${Math.round(n * 100)}%`;

const STAGES: { key: 'new' | 'contacted' | 'qualified' | 'won'; label: string; color: string }[] = [
  { key: 'new', label: 'Nuevos', color: '#94a3b8' },
  { key: 'contacted', label: 'Contactados', color: '#60a5fa' },
  { key: 'qualified', label: 'Cualificados', color: '#3b82f6' },
  { key: 'won', label: 'Ganados', color: '#16a34a' },
];

export function LeadsCard() {
  const q = useLeadsFunnel();

  const totals = q.data?.totals;
  const conv = q.data?.conversion;
  const data = totals
    ? STAGES.map((s) => ({ label: s.label, value: totals[s.key], color: s.color }))
    : [];
  const hasData = data.some((d) => d.value > 0) || (totals?.lost ?? 0) > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Captación de leads</CardTitle>
        <CardDescription>
          Embudo comercial.{' '}
          {conv && (
            <>
              Conversión a cliente{' '}
              <span className="font-medium text-foreground">{pct(conv.qualifiedToWon)}</span> de los
              cualificados
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="flex h-56 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : !hasData ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Aún no hay leads registrados.
          </p>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 224 }}
            >
              <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                />
                <Tooltip
                  formatter={(v) => String(Number(v) || 0)}
                  contentStyle={{ borderRadius: 8, fontSize: 13 }}
                />
                <Bar dataKey="value" name="Leads" radius={[4, 4, 0, 0]}>
                  {data.map((d) => (
                    <Cell key={d.label} fill={d.color} />
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

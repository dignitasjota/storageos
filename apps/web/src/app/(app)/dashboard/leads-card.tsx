'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { LeadsFunnelKpiDto } from '@storageos/shared';

import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const pct = (n: number) => `${Math.round(n * 100)}%`;

const STAGES: { key: 'total' | 'contacted' | 'qualified' | 'won'; label: string; color: string }[] =
  [
    { key: 'total', label: 'Recibidos', color: '#94a3b8' },
    { key: 'contacted', label: 'Contactados', color: '#60a5fa' },
    { key: 'qualified', label: 'Cualificados', color: '#3b82f6' },
    { key: 'won', label: 'Ganados', color: '#16a34a' },
  ];

export function LeadsCard({
  data: funnel,
  loading,
  onRetry,
}: {
  data: LeadsFunnelKpiDto | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  const totals = funnel?.totals;
  const conv = funnel?.conversion;
  // Embudo acumulado: cuántos contactos del periodo llegaron a cada fase.
  const reached = funnel ? { total: funnel.total, ...funnel.reached } : null;
  const data = reached
    ? STAGES.map((s) => ({ label: s.label, value: reached[s.key], color: s.color }))
    : [];
  const hasData = data.some((d) => d.value > 0) || (totals?.lost ?? 0) > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Contactos</CardTitle>
        <CardDescription>
          Contactos de los últimos 30 días.{' '}
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
        <SectionBody data={funnel} loading={loading} onRetry={onRetry} height="h-56">
          {() =>
            !hasData ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Aún no hay contactos en estos 30 días.
              </p>
            ) : (
              <div className="h-56 w-full">
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  initialDimension={{ width: 300, height: 224 }}
                >
                  <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                      width={32}
                    />
                    <Tooltip
                      formatter={(v) => String(Number(v) || 0)}
                      contentStyle={{ fontSize: 13 }}
                    />
                    <Bar dataKey="value" name="Contactos" radius={[4, 4, 0, 0]}>
                      {data.map((d) => (
                        <Cell key={d.label} fill={d.color} />
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

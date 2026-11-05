'use client';

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

import type { MonthlyRevenueKpiDto } from '@storageos/shared';

import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEur as eur, formatEurShort as eurShort } from '@/lib/format';

export function RevenueTrendCard({
  data,
  loading,
  onRetry,
}: {
  data: MonthlyRevenueKpiDto | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  const points = data?.points ?? [];
  const totalInvoiced = points.reduce((s, p) => s + p.invoiced, 0);
  const totalCollected = points.reduce((s, p) => s + p.collected, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ingresos — últimos 12 meses</CardTitle>
        <CardDescription>
          Facturado vs cobrado.{' '}
          {points.length > 0 && (
            <>
              Total facturado{' '}
              <span className="font-medium text-foreground">{eur(totalInvoiced)}</span> · cobrado{' '}
              <span className="font-medium text-foreground">{eur(totalCollected)}</span>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SectionBody data={data} loading={loading} onRetry={onRetry}>
          {() => (
            <div className="h-64 w-full">
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 300, height: 256 }}
              >
                <BarChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
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
                    tickFormatter={eurShort}
                    tick={{ fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                  />
                  <Tooltip
                    formatter={(v) => eur(Number(v) || 0)}
                    labelClassName="font-medium"
                    contentStyle={{ fontSize: 13 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="invoiced" name="Facturado" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="collected" name="Cobrado" fill="#2563eb" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}

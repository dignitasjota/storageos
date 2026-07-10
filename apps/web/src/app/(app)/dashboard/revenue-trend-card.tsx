'use client';

import { Loader2 } from 'lucide-react';
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

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMonthlyRevenue } from '@/lib/analytics/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const eurShort = (n: number) =>
  n >= 1000 ? `${Math.round(n / 100) / 10}k €` : `${Math.round(n)} €`;

export function RevenueTrendCard() {
  const q = useMonthlyRevenue(12);

  const points = q.data?.points ?? [];
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
        {q.isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : points.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Aún no hay datos de facturación.
          </p>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 256 }}
            >
              <BarChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
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
                  labelClassName="font-medium"
                  contentStyle={{ borderRadius: 8, fontSize: 13 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="invoiced" name="Facturado" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
                <Bar dataKey="collected" name="Cobrado" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

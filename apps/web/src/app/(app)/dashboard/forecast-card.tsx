'use client';

import { Loader2 } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useRevenueForecast } from '@/lib/analytics/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const eurShort = (n: number) =>
  n >= 1000 ? `${Math.round(n / 100) / 10}k €` : `${Math.round(n)} €`;

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('es-ES', { month: 'short', year: '2-digit' });
}

export function ForecastCard() {
  const q = useRevenueForecast({ months: 6 });

  const data = (q.data?.points ?? []).map((p) => ({
    label: monthLabel(p.yearMonth),
    mrr: Math.round(p.projectedMrr),
  }));
  const current = q.data?.current;
  const projectedEnd = data.length > 0 ? data[data.length - 1]!.mrr : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Previsión de MRR — 6 meses</CardTitle>
        <CardDescription>
          {current ? (
            <>
              Hoy <span className="font-medium text-foreground">{eur(current.mrr)}</span>
              {projectedEnd !== null && (
                <>
                  {' '}
                  → en 6 meses{' '}
                  <span className="font-medium text-foreground">{eur(projectedEnd)}</span>
                </>
              )}
            </>
          ) : (
            'Proyección por tendencia de altas y bajas.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : data.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No hay datos suficientes para proyectar.
          </p>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 256 }}
            >
              <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="mrrFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563eb" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
                  </linearGradient>
                </defs>
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
                  contentStyle={{ borderRadius: 8, fontSize: 13 }}
                />
                <Area
                  type="monotone"
                  dataKey="mrr"
                  name="MRR previsto"
                  stroke="#2563eb"
                  strokeWidth={2}
                  fill="url(#mrrFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

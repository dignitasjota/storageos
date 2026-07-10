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

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminMrrForecast } from '@/lib/admin/hooks';

const eur = (n: number) =>
  new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(n);

export function MrrForecastCard() {
  const q = useAdminMrrForecast(6);
  const d = q.data;

  // Serie = punto actual («Hoy») + los meses proyectados.
  const series = d ? [{ label: 'Hoy', mrr: d.currentMrr }, ...d.points] : [];
  const projectedEnd = d && d.points.length > 0 ? d.points[d.points.length - 1]!.mrr : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Previsión de MRR</CardTitle>
        <p className="text-xs text-muted-foreground">
          Proyección a 6 meses según la retención neta (NRR) y las altas medias del histórico.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : d.warmingUp ? (
          <p className="py-4 text-sm text-muted-foreground">
            Aún no hay histórico de MRR suficiente para proyectar. Se irá poblando con los cierres
            mensuales.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
              <div>
                <span className="text-2xl font-semibold">{eur(d.currentMrr)}</span>
                <span className="ml-1 text-xs text-muted-foreground">MRR actual</span>
              </div>
              <div>
                <span className="text-2xl font-semibold text-blue-600 dark:text-blue-400">
                  {eur(projectedEnd)}
                </span>
                <span className="ml-1 text-xs text-muted-foreground">previsto en 6 meses</span>
              </div>
            </div>
            <div className="h-56 w-full">
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 300, height: 224 }}
              >
                <AreaChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mrrForecast" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#2563eb" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={48} tickFormatter={(v) => eur(Number(v))} />
                  <Tooltip formatter={(v) => eur(Number(v))} labelClassName="text-xs" />
                  <Area
                    type="monotone"
                    dataKey="mrr"
                    name="MRR"
                    stroke="#2563eb"
                    fill="url(#mrrForecast)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-muted-foreground">
              Supuestos: NRR medio{' '}
              {d.assumptions.avgNrr !== null ? `${d.assumptions.avgNrr}%` : '—'} · altas medias{' '}
              {eur(d.assumptions.avgNewMrr)}/mes · sobre {d.assumptions.basedOnMonths} meses de
              histórico.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

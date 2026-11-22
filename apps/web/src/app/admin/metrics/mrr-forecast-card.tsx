'use client';

import { Loader2 } from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { AdminForecastAccuracyDto } from '@storageos/shared';

import { CsvButton } from '@/components/admin/metrics/csv-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminMrrForecast } from '@/lib/admin/hooks';
import { formatEur, formatEurShort, formatPct, plural } from '@/lib/format';

/** Colores de los escenarios: prudente, esperado y optimista. */
const SCENARIO_COLORS = { prudent: '#eb6834', expected: '#2563eb', optimistic: '#1baf7a' } as const;

export function MrrForecastCard() {
  const q = useAdminMrrForecast(6);
  const d = q.data;

  // Serie = punto actual («Hoy») + los meses proyectados de cada escenario.
  const series: Record<string, number | string>[] = d
    ? [
        {
          label: 'Hoy',
          prudent: d.currentMrr,
          expected: d.currentMrr,
          optimistic: d.currentMrr,
        },
        ...d.points.map((p, i) => {
          const row: Record<string, number | string> = { label: p.label };
          for (const s of d.scenarios) row[s.key] = s.points[i]?.mrr ?? p.mrr;
          return row;
        }),
      ]
    : [];
  const endOf = (key: string) => {
    const s = d?.scenarios.find((x) => x.key === key);
    return s && s.points.length > 0 ? s.points[s.points.length - 1]!.mrr : 0;
  };

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">Previsión de MRR</CardTitle>
          <CsvButton
            filename="prevision-mrr.csv"
            disabled={!d}
            rows={() => [
              ['Mes', 'Prudente', 'Esperado', 'Optimista'],
              ...series.map((r) => [
                String(r.label),
                Number(r.prudent),
                Number(r.expected),
                Number(r.optimistic),
              ]),
            ]}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Proyección a 6 meses (sin IVA). Esperado: la retención neta (NRR) y las altas medias de
          los meses cerrados. Prudente y optimista: el percentil 25 y 75 de esos meses.
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
            {d.insufficientHistory ? (
              <Warning>
                Poco histórico: hay{' '}
                {plural(d.assumptions.basedOnMonths, 'mes cerrado', 'meses cerrados')} con datos y
                hacen falta 3. Mientras tanto la previsión mantiene el MRR actual.
              </Warning>
            ) : (
              d.shortHistory && (
                <Warning>
                  Solo hay {plural(d.assumptions.basedOnMonths, 'mes cerrado', 'meses cerrados')}{' '}
                  con datos: los escenarios son orientativos hasta tener 6.
                </Warning>
              )
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="MRR actual" value={formatEur(d.currentMrr)} />
              <Figure label="Prudente en 6 meses" value={formatEur(endOf('prudent'))} />
              <Figure label="Esperado en 6 meses" value={formatEur(endOf('expected'))} accent />
              <Figure label="Optimista en 6 meses" value={formatEur(endOf('optimistic'))} />
            </div>
            <div className="h-56 w-full">
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 300, height: 224 }}
              >
                <LineChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    width={52}
                    tickFormatter={(v) => formatEurShort(Number(v))}
                  />
                  <Tooltip formatter={(v) => formatEur(Number(v))} labelClassName="text-xs" />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {d.scenarios.map((s) => (
                    <Line
                      key={s.key}
                      type="monotone"
                      dataKey={s.key}
                      name={s.label}
                      stroke={SCENARIO_COLORS[s.key]}
                      strokeWidth={s.key === 'expected' ? 2.5 : 1.5}
                      strokeDasharray={s.key === 'expected' ? undefined : '5 4'}
                      dot={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-muted-foreground">
              {d.scenarios
                .map(
                  (s) =>
                    `${s.label}: NRR ${s.nrr !== null ? formatPct(s.nrr) : '—'} y ${formatEur(s.newMrr)} de altas al mes`,
                )
                .join(' · ')}{' '}
              · sobre {plural(d.assumptions.basedOnMonths, 'mes cerrado', 'meses cerrados')}.
            </p>
            <Accuracy accuracy={d.accuracy} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
      {children}
    </p>
  );
}

/** Lo previsto hace 1-3 meses frente al MRR real al cierre de cada mes. */
function Accuracy({ accuracy }: { accuracy: AdminForecastAccuracyDto[] }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">Precisión de previsiones anteriores</h3>
      {accuracy.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Cada mes se guarda la previsión. Cuando pasen los meses previstos verás aquí lo que se
          previó frente al MRR real.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="p-2 font-medium">Mes</th>
                <th className="p-2 text-right font-medium">Real</th>
                <th className="p-2 text-right font-medium">Previsto</th>
                <th className="p-2 text-right font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {accuracy.flatMap((a) =>
                a.forecasts.map((f, i) => (
                  <tr key={`${a.month}-${f.monthsAhead}`} className="border-t">
                    <td className="whitespace-nowrap p-2">
                      {i === 0 ? `${a.label} ` : ''}
                      <span className="text-muted-foreground">
                        ({plural(f.monthsAhead, 'mes antes', 'meses antes')})
                      </span>
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {i === 0 ? formatEur(a.actual) : ''}
                    </td>
                    <td className="p-2 text-right tabular-nums">{formatEur(f.expected)}</td>
                    <td
                      className={`p-2 text-right tabular-nums ${f.withinRange ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}
                      title={
                        f.withinRange
                          ? 'El real cayó entre el prudente y el optimista'
                          : 'El real quedó fuera de los escenarios'
                      }
                    >
                      {f.errorPct === null
                        ? '—'
                        : `${f.errorPct > 0 ? '+' : ''}${formatPct(f.errorPct)}`}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`text-lg font-semibold tabular-nums ${accent ? 'text-blue-600 dark:text-blue-400' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
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

import {
  CsvButton,
  Delta,
  type Period,
  periodDays,
  periodText,
  previousPeriodDays,
  compareLabel,
  type CompareMode,
} from './period';
import { QueryState, shortMonth } from './ui';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCohorts, useOccupancyHistory, useRevenueBreakdown } from '@/lib/analytics/hooks';

/** Paleta categórica validada (orden fijo; nunca se reparte por posición). */
const SERIES = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
];
const MAX_LINES = SERIES.length;

const pct = (v: number) => `${Math.round(v * 100)} %`;
const eur = (v: number) => v.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

function RangeButtons({
  value,
  onChange,
  options,
}: {
  value: number;
  onChange: (n: number) => void;
  options: number[];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((n) => (
        <Button
          key={n}
          size="sm"
          variant={value === n ? 'default' : 'outline'}
          onClick={() => onChange(n)}
        >
          {n} meses
        </Button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ocupación mes a mes
// ---------------------------------------------------------------------------

export function OccupancyHistoryCard({
  facilityId,
  months,
  onMonthsChange,
}: {
  facilityId?: string;
  months: number;
  onMonthsChange: (n: number) => void;
}) {
  const [split, setSplit] = useState<'total' | 'facility' | 'type'>('total');
  const history = useOccupancyHistory({ months, facilityId });

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Ocupación mes a mes</CardTitle>
            <CardDescription>
              Trasteros con inquilino al cerrar cada mes (el actual, hoy). Un traslado no mueve la
              historia: cada trastero cuenta con quien lo tuvo.
            </CardDescription>
          </div>
          {history.data && (
            <CsvButton
              filename="ocupacion-historica.csv"
              rows={() => [
                ['Mes', 'Trasteros', 'Ocupados', 'Ocupación (%)', 'Cuotas al mes'],
                ...history.data!.points.map((p) => [
                  shortMonth(p.yearMonth),
                  p.totalUnits,
                  p.occupiedUnits,
                  Math.round(p.occupancy * 1000) / 10,
                  p.mrr ?? '',
                ]),
              ]}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangeButtons value={months} onChange={onMonthsChange} options={[6, 12, 24, 36]} />
          <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
          {(
            [
              ['total', 'Total'],
              ['facility', 'Por local'],
              ['type', 'Por tipo'],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={split === key ? 'secondary' : 'ghost'}
              onClick={() => setSplit(key)}
            >
              {label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <QueryState query={history} height="h-40">
          {(data) => <OccupancyHistoryBody data={data} split={split} />}
        </QueryState>
      </CardContent>
    </Card>
  );
}

function OccupancyHistoryBody({
  data,
  split,
}: {
  data: NonNullable<ReturnType<typeof useOccupancyHistory>['data']>;
  split: 'total' | 'facility' | 'type';
}) {
  const points = data.points;
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  // Lo da el servidor aparte: no depende de cuántos meses se vean.
  const yearAgo = data.yearAgo;
  const groups = split === 'facility' ? data.byFacility : split === 'type' ? data.byUnitType : [];
  const shown = groups.slice(0, MAX_LINES);

  const chartData = points.map((p, i) => {
    const row: Record<string, string | number> = { mes: shortMonth(p.yearMonth) };
    if (split === 'total') row['Ocupación'] = Math.round(p.occupancy * 1000) / 10;
    for (const g of shown) row[g.name] = Math.round((g.occupancy[i] ?? 0) * 1000) / 10;
    return row;
  });

  return (
    <div className="space-y-4">
      {last && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">Ocupación hoy</div>
            <div className="text-2xl font-semibold">{pct(last.occupancy)}</div>
            <div className="text-xs">
              {prev && (
                <Delta
                  current={last.occupancy}
                  previous={prev.occupancy}
                  suffix="vs mes anterior"
                  kind="rate"
                />
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Hace un año</div>
            <div className="text-2xl font-semibold">{yearAgo ? pct(yearAgo.occupancy) : '—'}</div>
            <div className="text-xs text-muted-foreground">
              {yearAgo
                ? `${yearAgo.occupiedUnits} de ${yearAgo.totalUnits} trasteros`
                : 'Aún no había trasteros'}
            </div>
          </div>
          {last.mrr !== null && (
            <div>
              <div className="text-xs text-muted-foreground">Cuotas al mes hoy</div>
              <div className="text-2xl font-semibold">{eur(last.mrr)}</div>
              <div className="text-xs">
                {prev && prev.mrr !== null && (
                  <Delta current={last.mrr} previous={prev.mrr} suffix="vs mes anterior" />
                )}
              </div>
            </div>
          )}
        </div>
      )}
      <div className="h-72">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 300, height: 256 }}
        >
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
            <YAxis unit="%" domain={[0, 100]} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => `${Number(v) || 0} %`} />
            {split === 'total' ? (
              <Line
                type="monotone"
                dataKey="Ocupación"
                stroke={SERIES[0]}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            ) : (
              shown.map((g, i) => (
                <Line
                  key={g.id}
                  type="monotone"
                  dataKey={g.name}
                  stroke={SERIES[i]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              ))
            )}
            {split !== 'total' && <Legend />}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {groups.length > MAX_LINES && (
        <p className="text-xs text-muted-foreground">
          La gráfica muestra los {MAX_LINES} primeros; la tabla, todos.
        </p>
      )}
      {split !== 'total' && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{split === 'facility' ? 'Local' : 'Tipo'}</TableHead>
                <TableHead className="text-right">Hace un mes</TableHead>
                <TableHead className="text-right">Hoy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => {
                const now = g.occupancy[g.occupancy.length - 1] ?? 0;
                const before = g.occupancy[g.occupancy.length - 2] ?? 0;
                return (
                  <TableRow key={g.id}>
                    <TableCell>{g.name}</TableCell>
                    <TableCell className="text-right">{pct(before)}</TableCell>
                    <TableCell className="text-right font-medium">{pct(now)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// De dónde sale lo facturado
// ---------------------------------------------------------------------------

const VIEW_FILE = { concept: 'concepto', facility: 'local', type: 'tipo' } as const;
const VIEW_HEADER = { concept: 'Concepto', facility: 'Local', type: 'Tipo de trastero' } as const;

export function RevenueBreakdownCard({
  facilityId,
  period,
  ownerId,
  compare = 'previous',
}: {
  facilityId?: string;
  period: Period;
  ownerId?: string;
  compare?: CompareMode;
}) {
  const breakdown = useRevenueBreakdown({ ...periodDays(period), facilityId, ownerId });
  // El de comparación, hasta el mismo día: el mes en curso va a medias.
  const previous = useRevenueBreakdown({
    ...previousPeriodDays(period, compare),
    facilityId,
    ownerId,
  });
  const [view, setView] = useState<'concept' | 'facility' | 'type'>('concept');
  const d = breakdown.data;
  const rows = d
    ? view === 'concept'
      ? d.byConcept
      : view === 'facility'
        ? d.byFacility
        : d.byUnitType
    : [];
  const prevRows = previous.data
    ? view === 'concept'
      ? previous.data.byConcept
      : view === 'facility'
        ? previous.data.byFacility
        : previous.data.byUnitType
    : null;
  const base = view === 'type' ? rows.reduce((s, r) => s + r.amount, 0) : (d?.total ?? 0);

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">De dónde sale lo facturado</CardTitle>
            <CardDescription>
              Base sin IVA de las facturas emitidas · {periodText(period)}
              {view === 'type' ? ' · solo el alquiler' : ''}.
            </CardDescription>
          </div>
          <CsvButton
            disabled={!d}
            filename={`facturado-por-${VIEW_FILE[view]}-${period.from}-${period.to}.csv`}
            rows={() => [
              [VIEW_HEADER[view], 'Base sin IVA'],
              ...rows.map((r) => [r.label, r.amount]),
            ]}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['concept', 'Por concepto'],
              ['facility', 'Por local'],
              ['type', 'Por tipo de trastero'],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={view === key ? 'secondary' : 'ghost'}
              onClick={() => setView(key)}
            >
              {label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {!d ? (
          <QueryState query={breakdown} height="h-40">
            {() => null}
          </QueryState>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay facturas en el periodo.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => {
              const share = base > 0 ? r.amount / base : 0;
              const before = prevRows?.find((p) => p.key === r.key)?.amount ?? 0;
              return (
                <li key={r.key} className="space-y-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                    <span className="font-medium">{r.label}</span>
                    <span>
                      <span className="font-semibold">{eur(r.amount)}</span>{' '}
                      <span className="text-muted-foreground">({pct(share)})</span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(2, share * 100)}%`, backgroundColor: SERIES[0] }}
                    />
                  </div>
                  {prevRows && (
                    <div className="text-xs">
                      <Delta
                        current={r.amount}
                        previous={before}
                        suffix={compareLabel(compare, { sameDay: true })}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cohortes de altas
// ---------------------------------------------------------------------------

function retentionTint(v: number | null): string {
  if (v === null) return 'text-muted-foreground';
  if (v >= 0.8) return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  if (v >= 0.6) return 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
  return 'bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-300';
}

export function CohortsPanel({
  facilityId,
  ownerId,
  months,
  onMonthsChange,
}: {
  facilityId?: string;
  ownerId?: string;
  months: number;
  onMonthsChange: (n: number) => void;
}) {
  const cohorts = useCohorts({ months, facilityId, ownerId });
  const rows = cohorts.data?.cohorts ?? [];
  // Una columna que no puede tener datos con este rango (p. ej. «a 12 meses» con
  // 12 meses: nadie lleva aún un año) no se enseña.
  const has = {
    r3: rows.some((c) => c.retained3 !== null),
    r6: rows.some((c) => c.retained6 !== null),
    r12: rows.some((c) => c.retained12 !== null),
  };
  const showRevenue = rows.some((c) => c.revenuePerContract !== null);

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Permanencia según el mes de alta</CardTitle>
            <CardDescription>
              Contratos agrupados por el mes en que empezaron: cuántos seguían a los 3, 6 y 12
              meses, cuánto han durado y lo que ha facturado cada uno de media (con IVA). «—» = aún
              no ha pasado ese tiempo.
            </CardDescription>
          </div>
          <CsvButton
            disabled={rows.length === 0}
            filename="permanencia-por-mes-de-alta.csv"
            rows={() => [
              [
                'Mes de alta',
                'Contratos',
                'A 3 meses (%)',
                'A 6 meses (%)',
                'A 12 meses (%)',
                'Meses de media',
                ...(showRevenue ? ['Facturado por contrato (con IVA)'] : []),
              ],
              ...rows.map((c) => [
                shortMonth(c.yearMonth),
                c.contracts,
                c.retained3 === null ? '' : Math.round(c.retained3 * 100),
                c.retained6 === null ? '' : Math.round(c.retained6 * 100),
                c.retained12 === null ? '' : Math.round(c.retained12 * 100),
                c.avgStayMonths,
                ...(showRevenue ? [c.revenuePerContract ?? ''] : []),
              ]),
            ]}
          />
        </div>
        <RangeButtons value={months} onChange={onMonthsChange} options={[6, 12, 24, 36]} />
      </CardHeader>
      <CardContent>
        <QueryState query={cohorts} height="h-40">
          {(data) =>
            data.cohorts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay contratos firmados en el periodo.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mes de alta</TableHead>
                      <TableHead className="text-right">Contratos</TableHead>
                      {has.r3 && <TableHead className="text-center">A 3 meses</TableHead>}
                      {has.r6 && <TableHead className="text-center">A 6 meses</TableHead>}
                      {has.r12 && <TableHead className="text-center">A 12 meses</TableHead>}
                      <TableHead className="text-right">Meses de media</TableHead>
                      {showRevenue && (
                        <TableHead className="text-right">Facturado por contrato</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.cohorts.map((c) => (
                      <TableRow key={c.yearMonth}>
                        <TableCell className="capitalize">{shortMonth(c.yearMonth)}</TableCell>
                        <TableCell className="text-right">{c.contracts}</TableCell>
                        {(
                          [
                            [has.r3, c.retained3],
                            [has.r6, c.retained6],
                            [has.r12, c.retained12],
                          ] as const
                        )
                          .filter(([shown]) => shown)
                          .map(([, v], i) => (
                            <TableCell key={i} className="text-center">
                              <span
                                className={`rounded px-2 py-0.5 text-xs font-medium ${retentionTint(v)}`}
                              >
                                {v === null ? '—' : pct(v)}
                              </span>
                            </TableCell>
                          ))}
                        <TableCell className="text-right">
                          {c.avgStayMonths.toLocaleString('es-ES')}
                        </TableCell>
                        {showRevenue && (
                          <TableCell className="text-right">
                            {c.revenuePerContract === null ? '—' : eur(c.revenuePerContract)}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          }
        </QueryState>
        {!has.r12 && rows.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Para ver cuántos siguen al año, elige 24 o 36 meses.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

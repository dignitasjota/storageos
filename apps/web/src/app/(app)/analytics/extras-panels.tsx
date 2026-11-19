'use client';

import { FileDown, MessageCircle, Phone } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { CsvButton, type Period } from './period';
import { ChartData, eur, formatPct, KpiCard, monthName, QueryState, shortMonth } from './ui';

import type {
  ChurnRiskItemDto,
  ForecastScenarioKey,
  LeadsFunnelKpiDto,
  TenureBucket,
} from '@storageos/shared';

import { MonthYearSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useAnalyticsHeadline,
  useArrearsBreakdown,
  useChurnBreakdown,
  useForecastScenarios,
  usePortfolioGap,
  useUnitEconomics,
} from '@/lib/analytics/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { formatDate } from '@/lib/format';
import { useMarketingPerformance } from '@/lib/marketing/hooks';
import { useReport, useReportDownloadUrl, useRunReport } from '@/lib/reports/hooks';

// ============================================================================
// Resumen del mes en una línea
// ============================================================================

function changeText(current: number, previous: number | null): string | null {
  if (previous === null) return null;
  if (previous === 0) return current === 0 ? null : 'antes 0';
  const p = Math.round(((current - previous) / previous) * 100);
  if (p === 0) return 'igual';
  return `${p > 0 ? '+' : ''}${p} %`;
}

/** Cómo va el mes en curso frente al pasado hasta el mismo día, en una línea. */
export function HeadlineLine({ facilityId, ownerId }: { facilityId?: string; ownerId?: string }) {
  const headline = useAnalyticsHeadline({ facilityId, ownerId });
  const d = headline.data;
  if (!d) return null;
  const month = monthName(d.yearMonth).replace(/ de \d{4}$/, '');
  const parts: string[] = [];
  if (d.invoiced !== null) {
    const c = changeText(d.invoiced, d.invoicedPrev);
    parts.push(`${eur(d.invoiced)} facturados${c ? ` (${c})` : ''}`);
  }
  const points =
    d.occupancyPrev === null ? null : Math.round((d.occupancy - d.occupancyPrev) * 1000) / 10;
  parts.push(
    `ocupación del ${formatPct(d.occupancy, 0)}${
      points === null || points === 0
        ? ''
        : ` (${points > 0 ? '+' : ''}${points.toLocaleString('es-ES')} puntos)`
    }`,
  );
  parts.push(
    `${d.moveIns} ${d.moveIns === 1 ? 'alta' : 'altas'} y ${d.moveOuts} ${d.moveOuts === 1 ? 'baja' : 'bajas'}`,
  );
  const leads = changeText(d.leads, d.leadsPrev);
  parts.push(`${d.leads} ${d.leads === 1 ? 'contacto' : 'contactos'}${leads ? ` (${leads})` : ''}`);
  return (
    <p className="rounded-lg border bg-card px-4 py-3 text-sm">
      <span className="font-medium">
        En {month}, hasta el día {d.day}:
      </span>{' '}
      {parts.join(', ')}.
      {d.overdue !== null && d.overdue > 0 && (
        <>
          {' '}
          Vencido sin cobrar:{' '}
          <Link href="/arrears" className="font-medium text-primary underline">
            {eur(d.overdue)}
          </Link>
          .
        </>
      )}
      <span className="block text-xs text-muted-foreground">
        Entre paréntesis, frente a lo mismo del mes pasado hasta el día {d.day}.
      </span>
    </p>
  );
}

// ============================================================================
// Deudas: por inquilino, por local y días que se tarda en cobrar
// ============================================================================

export function ArrearsBreakdownCard({
  facilityId,
  ownerId,
}: {
  facilityId?: string;
  ownerId?: string;
}) {
  const breakdown = useArrearsBreakdown({ facilityId, ownerId });
  return (
    <QueryState query={breakdown} height="h-32">
      {(d) => (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <KpiCard
              title="Días hasta cobrar"
              value={
                d.avgDaysToCollect === null
                  ? '—'
                  : `${d.avgDaysToCollect.toLocaleString('es-ES')} días`
              }
            >
              De media desde que se emite la factura, con las cobradas en los últimos 90 días (
              {d.collectedInvoices}).
            </KpiCard>
            <KpiCard
              title="Retraso sobre el vencimiento"
              value={d.avgDaysLate === null ? '—' : `${d.avgDaysLate.toLocaleString('es-ES')} días`}
            >
              Cuánto pasan de media del día de vencimiento hasta pagar.
            </KpiCard>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
                <div className="space-y-1.5">
                  <CardTitle className="text-base">Quién debe más</CardTitle>
                  <CardDescription>
                    {d.customerCount === 0
                      ? 'Nadie tiene facturas vencidas.'
                      : `${d.customerCount} ${d.customerCount === 1 ? 'inquilino con deuda vencida' : 'inquilinos con deuda vencida'}${d.customerCount > 10 ? '; aquí los 10 que más deben' : ''}.`}
                  </CardDescription>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href="/arrears">Ver deudores</Link>
                </Button>
              </CardHeader>
              {d.byCustomer.length > 0 && (
                <CardContent className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Inquilino</TableHead>
                        <TableHead className="text-right">Facturas</TableHead>
                        <TableHead className="text-right">Desde hace</TableHead>
                        <TableHead className="text-right">Debe</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.byCustomer.map((c) => (
                        <TableRow key={c.customerId}>
                          <TableCell className="font-medium">
                            <Link href={`/customers/${c.customerId}`} className="hover:underline">
                              {c.customerName}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right">{c.invoices}</TableCell>
                          <TableCell className="text-right">{c.oldestDays} días</TableCell>
                          <TableCell className="text-right font-medium">{eur(c.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              )}
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Por local</CardTitle>
                <CardDescription>Dónde está la deuda vencida.</CardDescription>
              </CardHeader>
              {d.byFacility.length > 0 && (
                <CardContent>
                  <ul className="space-y-2.5">
                    {d.byFacility.map((f) => {
                      const total = d.byFacility.reduce((s, x) => s + x.amount, 0);
                      const pct = total > 0 ? (f.amount / total) * 100 : 0;
                      return (
                        <li key={f.facilityId ?? 'none'} className="text-sm">
                          <div className="flex justify-between gap-3">
                            <span>{f.facilityName}</span>
                            <span className="tabular-nums text-muted-foreground">
                              {eur(f.amount)} · {f.invoices}{' '}
                              {f.invoices === 1 ? 'factura' : 'facturas'}
                            </span>
                          </div>
                          <div className="mt-1 h-2 rounded bg-muted">
                            <div
                              className="h-2 rounded bg-rose-500"
                              style={{ width: `${Math.max(2, pct)}%` }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              )}
            </Card>
          </div>
        </div>
      )}
    </QueryState>
  );
}

// ============================================================================
// Riesgo de baja: llamar, WhatsApp y retención
// ============================================================================

/** Teléfono a solo cifras con prefijo de España si no lo lleva. */
function whatsappNumber(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits.slice(1);
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.length === 9) return `34${digits}`;
  return digits.length >= 9 ? digits : null;
}

export function ChurnRiskActions({ item }: { item: ChurnRiskItemDto }) {
  const wa = item.phone ? whatsappNumber(item.phone) : null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {item.phone && (
        <Button asChild size="icon" variant="outline" aria-label={`Llamar a ${item.customerName}`}>
          <a href={`tel:${item.phone.replace(/\s/g, '')}`} title="Llamar">
            <Phone className="size-4" />
          </a>
        </Button>
      )}
      {wa && (
        <Button
          asChild
          size="icon"
          variant="outline"
          aria-label={`WhatsApp a ${item.customerName}`}
        >
          <a
            href={`https://wa.me/${wa}`}
            target="_blank"
            rel="noopener noreferrer"
            title="WhatsApp"
          >
            <MessageCircle className="size-4" />
          </a>
        </Button>
      )}
      <Button asChild size="sm" variant="outline">
        {item.contractStatus === 'ending' ? (
          <Link href={`/contracts/${item.contractId}`}>Ofrecer retención</Link>
        ) : (
          <Link href={`/customers/${item.customerId}`}>Ver ficha</Link>
        )}
      </Button>
    </div>
  );
}

// ============================================================================
// Precios: inquilinos que pagan menos que el precio de hoy
// ============================================================================

export function PortfolioGapPanel({ facilityId }: { facilityId?: string }) {
  const gap = usePortfolioGap(facilityId);
  return (
    <QueryState query={gap}>
      {(d) => (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
            <div className="space-y-1.5">
              <CardTitle className="text-base">Inquilinos por debajo del precio de hoy</CardTitle>
              <CardDescription>
                Contratos en vigor que pagan menos que el precio actual de su trastero (sin IVA).
                {d.rows.length > 0 &&
                  ` Si todos pagaran el precio de hoy: +${eur(d.totalGapMonthly)} al mes (${d.rows.length} de ${d.liveContracts} contratos).`}{' '}
                Para subirles la cuota, usa las subidas de precio (con su preaviso).
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <CsvButton
                disabled={d.rows.length === 0}
                filename="por-debajo-del-precio.csv"
                rows={() => [
                  [
                    'Inquilino',
                    'Contrato',
                    'Trastero',
                    'Local',
                    'Paga',
                    'Precio de hoy',
                    'Diferencia',
                    'Desde',
                  ],
                  ...d.rows.map((r) => [
                    r.customerName,
                    r.contractNumber,
                    r.unitCode,
                    r.facilityName,
                    r.paying,
                    r.listPrice,
                    r.gap,
                    formatDate(r.since),
                  ]),
                ]}
              />
              <Button asChild size="sm">
                <Link href="/rent-increases">Subidas de precio</Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {d.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Todos tus inquilinos pagan el precio de hoy o más.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Inquilino</TableHead>
                    <TableHead>Trastero</TableHead>
                    <TableHead className="text-right">Paga</TableHead>
                    <TableHead className="text-right">Precio de hoy</TableHead>
                    <TableHead className="text-right">Diferencia</TableHead>
                    <TableHead>Sin cambios desde</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.rows.map((r) => (
                    <TableRow key={r.contractId}>
                      <TableCell className="font-medium">
                        <Link href={`/contracts/${r.contractId}`} className="hover:underline">
                          {r.customerName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {r.unitCode}
                        <span className="block text-xs text-muted-foreground">
                          {r.facilityName}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">{eur(r.paying)}</TableCell>
                      <TableCell className="text-right">{eur(r.listPrice)}</TableCell>
                      <TableCell className="text-right font-medium">
                        +{eur(r.gap)}
                        <span className="block text-xs text-muted-foreground">
                          {r.gapPct.toLocaleString('es-ES')} %
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(r.since)}
                        <span className="block text-xs text-muted-foreground">
                          {r.monthsSince} {r.monthsSince === 1 ? 'mes' : 'meses'}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </QueryState>
  );
}

// ============================================================================
// Ocupación: rendimiento por m² y por tipo
// ============================================================================

const perM2 = (v: number | null) => (v === null ? '—' : `${eur(v)}/m²`);

export function UnitEconomicsCard({ facilityId }: { facilityId?: string }) {
  const economics = useUnitEconomics(facilityId);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Rendimiento por tipo de trastero</CardTitle>
          <CardDescription>
            Cuotas al mes (sin IVA) por m² alquilado y por m² total, y lo que pagan de media frente
            al precio de hoy de esos trasteros.
          </CardDescription>
        </div>
        <CsvButton
          disabled={!economics.data?.rows.length}
          filename="rendimiento-por-tipo.csv"
          rows={() => [
            [
              'Tipo',
              'Trasteros',
              'Alquilados',
              'Cuotas al mes',
              '€/m² alquilado',
              '€/m² total',
              'Cuota media',
              'Precio medio de hoy',
            ],
            ...(economics.data?.rows ?? []).map((r) => [
              r.name,
              r.units,
              r.occupied,
              r.revenueMonthly,
              r.revenuePerRentedM2 ?? '',
              r.revenuePerM2 ?? '',
              r.avgFee ?? '',
              r.avgListPrice ?? '',
            ]),
          ]}
        />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <QueryState query={economics} height="h-24">
          {(d) =>
            d.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aún no hay trasteros.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right">Alquilados</TableHead>
                    <TableHead className="text-right">Cuotas al mes</TableHead>
                    <TableHead className="text-right">Por m² alquilado</TableHead>
                    <TableHead className="text-right">Por m² total</TableHead>
                    <TableHead className="text-right">Cuota media / precio de hoy</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...d.rows, { unitTypeId: 'total', name: 'Total', ...d.totals }].map((r) => (
                    <TableRow
                      key={r.unitTypeId}
                      className={r.unitTypeId === 'total' ? 'font-medium' : undefined}
                    >
                      <TableCell>{r.name}</TableCell>
                      <TableCell className="text-right">
                        {r.occupied} de {r.units}
                      </TableCell>
                      <TableCell className="text-right">{eur(r.revenueMonthly)}</TableCell>
                      <TableCell className="text-right">{perM2(r.revenuePerRentedM2)}</TableCell>
                      <TableCell className="text-right">{perM2(r.revenuePerM2)}</TableCell>
                      <TableCell className="text-right">
                        {r.avgFee === null || r.avgListPrice === null ? (
                          '—'
                        ) : (
                          <>
                            {eur(r.avgFee)} / {eur(r.avgListPrice)}
                            {r.feeVsListPct !== null && r.feeVsListPct !== 0 && (
                              <span
                                className={`block text-xs ${
                                  r.feeVsListPct < 0 ? 'text-amber-600' : 'text-emerald-600'
                                }`}
                              >
                                {r.feeVsListPct > 0 ? '+' : ''}
                                {r.feeVsListPct.toLocaleString('es-ES')} %
                              </span>
                            )}
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </QueryState>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Bajas: cuotas que entran y salen, y antigüedad
// ============================================================================

const TENURE_LABELS: Record<TenureBucket, string> = {
  lt3: 'Menos de 3 meses',
  '3to6': '3 a 6 meses',
  '6to12': '6 a 12 meses',
  '12to24': '1 a 2 años',
  gt24: 'Más de 2 años',
};

export function ChurnBreakdownCards({
  facilityId,
  period,
}: {
  facilityId?: string;
  period: Period;
}) {
  const breakdown = useChurnBreakdown({ from: period.from, to: period.to, facilityId });
  return (
    <QueryState query={breakdown} height="h-32">
      {(d) => {
        const money = d.months.some((m) => m.mrrGained !== null);
        const chartData = d.months.map((m) => ({
          mes: shortMonth(m.yearMonth),
          Entran: m.mrrGained ?? 0,
          Salen: -(m.mrrLost ?? 0),
        }));
        const maxTenure = Math.max(1, ...d.tenure.map((t) => t.ended));
        return (
          <div className="grid gap-4 lg:grid-cols-2">
            {money && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Cuotas que entran y salen</CardTitle>
                  <CardDescription>
                    Cuotas al mes (sin IVA) de las altas y de las bajas de cada mes.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer
                      width="100%"
                      height="100%"
                      initialDimension={{ width: 300, height: 256 }}
                    >
                      <BarChart data={chartData} stackOffset="sign">
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                        <YAxis tickFormatter={(v) => `${Math.round(Number(v) || 0)} €`} />
                        <Tooltip formatter={(v) => eur(Math.abs(Number(v) || 0))} />
                        <Legend />
                        <Bar dataKey="Entran" stackId="a" fill="#16a34a" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="Salen" stackId="a" fill="#dc2626" radius={[0, 0, 4, 4]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <ChartData
                    headers={['Mes', 'Entran', 'Salen', 'Neto']}
                    rows={d.months.map((m) => [
                      shortMonth(m.yearMonth),
                      eur(m.mrrGained ?? 0),
                      eur(m.mrrLost ?? 0),
                      eur((m.mrrGained ?? 0) - (m.mrrLost ?? 0)),
                    ])}
                  />
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cuánto llevaban los que se van</CardTitle>
                <CardDescription>
                  {d.ended === 0
                    ? 'Nadie se ha dado de baja en este periodo.'
                    : `Las ${d.ended} bajas del periodo, según el tiempo que llevaban.`}
                </CardDescription>
              </CardHeader>
              {d.ended > 0 && (
                <CardContent>
                  <ul className="space-y-2.5">
                    {d.tenure.map((t) => (
                      <li key={t.bucket} className="text-sm">
                        <div className="flex justify-between gap-3">
                          <span>{TENURE_LABELS[t.bucket]}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {t.ended} · {Math.round((t.ended / d.ended) * 100)} %
                          </span>
                        </div>
                        <div className="mt-1 h-2 rounded bg-muted">
                          <div
                            className="h-2 rounded bg-[#2a78d6]"
                            style={{ width: `${(t.ended / maxTenure) * 100}%` }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              )}
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}

// ============================================================================
// Previsión: escenarios y cuándo se llena cada local y tipo
// ============================================================================

const SCENARIO: Record<ForecastScenarioKey, { label: string; color: string; hint: string }> = {
  low: { label: 'Prudente', color: '#d97706', hint: 'la mitad de altas y más bajas' },
  expected: { label: 'Esperado', color: '#2563eb', hint: 'como hasta ahora' },
  high: { label: 'Optimista', color: '#16a34a', hint: 'la mitad más de altas y menos bajas' },
};

function fullByText(fullBy: string | null): string {
  return fullBy ? monthName(fullBy) : 'No en 5 años';
}

export function ForecastScenariosCards({ facilityId }: { facilityId?: string }) {
  const scenarios = useForecastScenarios(facilityId);
  return (
    <QueryState query={scenarios} height="h-32">
      {(d) => {
        const chartData = (d.scenarios[0]?.points ?? []).map((p, i) => {
          const row: Record<string, string | number> = { mes: shortMonth(p.yearMonth) };
          for (const s of d.scenarios) row[SCENARIO[s.key].label] = s.points[i]?.contracts ?? 0;
          return row;
        });
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {d.scenarios.map((s) => (
                <KpiCard
                  key={s.key}
                  title={`${SCENARIO[s.key].label}: te llenas en`}
                  value={fullByText(s.fullBy)}
                >
                  {SCENARIO[s.key].hint} ({s.adds.toLocaleString('es-ES')} altas al mes y{' '}
                  {formatPct(s.churnRate, 1)} de bajas).
                </KpiCard>
              ))}
            </div>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contratos en los tres escenarios</CardTitle>
                <CardDescription>
                  Los próximos 12 meses con las medias de {d.historyMonths}{' '}
                  {d.historyMonths === 1 ? 'mes cerrado' : 'meses cerrados'}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    initialDimension={{ width: 300, height: 256 }}
                  >
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Legend />
                      {d.scenarios.map((s) => (
                        <Line
                          key={s.key}
                          type="monotone"
                          dataKey={SCENARIO[s.key].label}
                          stroke={SCENARIO[s.key].color}
                          strokeWidth={2}
                          dot={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <ChartData
                  headers={['Mes', ...d.scenarios.map((s) => SCENARIO[s.key].label)]}
                  rows={chartData.map((r) => [
                    String(r.mes),
                    ...d.scenarios.map((s) => Number(r[SCENARIO[s.key].label] ?? 0)),
                  ])}
                />
              </CardContent>
            </Card>
            {d.segments.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Cuándo se llena cada local y tamaño</CardTitle>
                  <CardDescription>
                    Con las altas menos las bajas de cada uno en los meses cerrados.
                  </CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Local o tamaño</TableHead>
                        <TableHead className="text-right">Ocupados</TableHead>
                        <TableHead className="text-right">Al mes</TableHead>
                        <TableHead>Se llena en</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.segments.map((s) => (
                        <TableRow key={`${s.kind}-${s.id}`}>
                          <TableCell>
                            {s.name}
                            <span className="block text-xs text-muted-foreground">
                              {s.kind === 'facility' ? 'Local' : 'Tamaño'}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            {s.occupied} de {s.capacity}
                          </TableCell>
                          <TableCell className="text-right">
                            {s.netPerMonth > 0 ? '+' : ''}
                            {s.netPerMonth.toLocaleString('es-ES')}
                          </TableCell>
                          <TableCell>
                            {s.capacity > 0 && s.occupied >= s.capacity
                              ? 'Ya está lleno'
                              : fullByText(s.fullBy)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </div>
        );
      }}
    </QueryState>
  );
}

// ============================================================================
// Contactos: tiempos y coste por cliente de cada canal
// ============================================================================

function hoursText(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toLocaleString('es-ES', { maximumFractionDigits: 1 })} h`;
  return `${(hours / 24).toLocaleString('es-ES', { maximumFractionDigits: 1 })} días`;
}

export function LeadsTimingCards({ timing }: { timing: LeadsFunnelKpiDto['timing'] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <KpiCard title="Tiempo hasta responder" value={hoursText(timing.firstResponseHours)}>
        Lo normal (la mediana) desde que llega un contacto hasta que pasa a contactado (
        {timing.responded} respondidos).
      </KpiCard>
      <KpiCard
        title="Tiempo hasta contratar"
        value={
          timing.daysToWin === null
            ? '—'
            : `${timing.daysToWin.toLocaleString('es-ES', { maximumFractionDigits: 1 })} días`
        }
      >
        Lo normal desde que llega hasta que se gana.
      </KpiCard>
    </div>
  );
}

export function ChannelCostCard({
  from,
  to,
  facilityId,
}: {
  from: string;
  to: string;
  facilityId?: string;
}) {
  const canMarketing = useHasPermission('marketing:read');
  if (!canMarketing) return null;
  return <ChannelCostInner from={from} to={to} {...(facilityId ? { facilityId } : {})} />;
}

function ChannelCostInner({
  from,
  to,
  facilityId,
}: {
  from: string;
  to: string;
  facilityId?: string;
}) {
  const performance = useMarketingPerformance({ from, to, facilityId: facilityId ?? null });
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Coste por cliente de cada canal</CardTitle>
          <CardDescription>
            Lo gastado en cada canal de Marketing entre los contactos y los clientes que trajo en
            este periodo.
          </CardDescription>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/marketing/performance">Ver en Marketing</Link>
        </Button>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <QueryState query={performance} height="h-24">
          {(d) =>
            d.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aún no tienes canales de marketing. Créalos en Marketing → Canales para ver lo que
                te cuesta cada cliente.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Canal</TableHead>
                    <TableHead className="text-right">Gastado</TableHead>
                    <TableHead className="text-right">Contactos</TableHead>
                    <TableHead className="text-right">Clientes</TableHead>
                    <TableHead className="text-right">Por contacto</TableHead>
                    <TableHead className="text-right">Por cliente</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.rows.map((r) => (
                    <TableRow key={r.channelId}>
                      <TableCell className="font-medium">{r.channelName}</TableCell>
                      <TableCell className="text-right">{eur(r.cost)}</TableCell>
                      <TableCell className="text-right">{r.leadsCount}</TableCell>
                      <TableCell className="text-right">{r.wonCount}</TableCell>
                      <TableCell className="text-right">
                        {r.costPerLead === null ? '—' : eur(r.costPerLead)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {r.cac === null ? '—' : eur(r.cac)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </QueryState>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Resumen del mes en PDF
// ============================================================================

function lastClosedMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function MonthPdfButton() {
  const canRun = useHasPermission('reports:run');
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(lastClosedMonth);
  const [runId, setRunId] = useState<string | undefined>();
  const run = useRunReport();
  const report = useReport(runId);
  const download = useReportDownloadUrl();
  const status = report.data?.status;

  useEffect(() => {
    if (!runId || !status) return;
    if (status === 'done') {
      setRunId(undefined);
      download
        .mutateAsync(runId)
        .then(({ url }) => {
          window.open(url, '_blank', 'noopener,noreferrer');
          setOpen(false);
        })
        .catch(() => toast.error('No se pudo descargar. Lo tienes también en Informes.'));
    } else if (status === 'failed' || status === 'expired') {
      setRunId(undefined);
      toast.error('No se pudo generar el resumen. Inténtalo de nuevo.');
    }
  }, [runId, status, download]);

  if (!canRun) return null;
  const busy = run.isPending || runId !== undefined;

  async function onGenerate() {
    try {
      const res = await run.mutateAsync({
        generator: 'analytics_month',
        format: 'pdf',
        params: { month },
      });
      setRunId(res.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo generar.');
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FileDown className="mr-1 size-4" /> Resumen del mes en PDF
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resumen del mes en PDF</DialogTitle>
            <DialogDescription>
              Facturado, cobrado, ocupación, cuotas, altas, bajas y contactos del mes frente al
              anterior. Queda también en Informes.
            </DialogDescription>
          </DialogHeader>
          <MonthYearSelect value={month} onChange={setMonth} />
          <DialogFooter>
            <Button disabled={busy} onClick={() => void onGenerate()}>
              {busy ? 'Generando…' : 'Descargar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

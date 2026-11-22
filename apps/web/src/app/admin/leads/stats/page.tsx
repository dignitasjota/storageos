'use client';

import {
  PLATFORM_LEAD_DISCARD_REASON_LABELS,
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_SOURCE_LABELS,
  PLATFORM_LEAD_SOURCES,
  PLATFORM_LEAD_STAGE_LABELS,
  type PlatformLeadSource,
  type PlatformLeadStatsGroupDto,
} from '@storageos/shared';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { AdminError } from '@/components/admin/admin-error';
import { CsvButton } from '@/components/admin/metrics/csv-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminLeadStats } from '@/lib/admin/leads-hooks';
import { formatCount, formatEur, formatNumber, formatPct, plural } from '@/lib/format';

const pct = (part: number, whole: number) => (whole > 0 ? formatPct((part / whole) * 100) : '—');

/** Una fila de barra: etiqueta, barra de un solo color y la cifra escrita. */
function BarRow({
  label,
  value,
  max,
  note,
}: {
  label: string;
  value: number;
  max: number;
  note?: string;
}) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
      <span className="truncate text-muted-foreground">{label}</span>
      <div className="h-3 rounded-full bg-muted" aria-hidden>
        <div
          className="h-3 rounded-full bg-primary"
          style={{ width: `${value > 0 ? width : 0}%` }}
        />
      </div>
      <span className="tabular-nums">
        {formatCount(value)}
        {note ? <span className="ml-1 text-muted-foreground">{note}</span> : null}
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  change,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Variación frente al periodo anterior («+3», «−12 %»…) y si es buena. */
  change?: { text: string; good: boolean | null } | null;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {change && (
          <p
            className={`text-xs tabular-nums ${
              change.good === null
                ? 'text-muted-foreground'
                : change.good
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-destructive'
            }`}
          >
            {change.text} vs. periodo anterior
          </p>
        )}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** «+3» / «−2» con el signo y si subir es bueno. */
function delta(
  now: number | null,
  before: number | null,
  opts: { higherIsBetter?: boolean; format?: (n: number) => string } = {},
): { text: string; good: boolean | null } | null {
  if (now === null || before === null) return null;
  const diff = Math.round((now - before) * 10) / 10;
  if (diff === 0) return { text: 'igual', good: null };
  const fmt = opts.format ?? ((n: number) => formatNumber(n, Number.isInteger(n) ? 0 : 1));
  const better = opts.higherIsBetter ?? true;
  return {
    text: `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))}`,
    good: diff > 0 ? better : !better,
  };
}

/** Tabla de leads, clientes, conversión y cuota de un grupo (responsable o campaña). */
function GroupTable({
  title,
  rows,
  csvName,
  column,
}: {
  title: string;
  rows: PlatformLeadStatsGroupDto[];
  csvName: string;
  column: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CsvButton
          filename={csvName}
          disabled={rows.length === 0}
          rows={() => [
            [column, 'Leads', 'Clientes', 'Conversión (%)', 'Pagan al mes (sin IVA)'],
            ...rows.map((r) => [r.label, r.leads, r.customers, r.conversionPct ?? '', r.mrr]),
          ]}
        />
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Sin datos en el periodo.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{column}</th>
                  <th className="px-4 py-2 text-right font-medium">Leads</th>
                  <th className="px-4 py-2 text-right font-medium">Clientes</th>
                  <th className="px-4 py-2 text-right font-medium">Conversión</th>
                  <th className="px-4 py-2 text-right font-medium">Pagan al mes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key ?? '-'} className="border-b last:border-0">
                    <td className="px-4 py-2">{r.label}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCount(r.leads)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatCount(r.customers)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {r.conversionPct === null ? '—' : formatPct(r.conversionPct)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatEur(r.mrr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Resultados de los leads: de cuántos llegan a cliente, qué orígenes traen
 * clientes que pagan, cuánto se tarda en responder y por qué se pierden.
 */
export default function AdminLeadStatsPage() {
  const [months, setMonths] = useState(6);
  const [source, setSource] = useState<PlatformLeadSource | 'all'>('all');
  const q = useAdminLeadStats(months, source === 'all' ? null : source);
  const s = q.data;
  // Clientes: los que se trabajaron y llegaron a pagar más los que entraron solos y pagan.
  const worked = s?.funnel.find((f) => f.stage === 'new')?.reached ?? 0;
  const customers =
    (s?.funnel.find((f) => f.stage === 'customer')?.reached ?? 0) + (s?.direct.customers ?? 0);

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-1" asChild>
            <Link href="/admin/leads">
              <ArrowLeft className="mr-1 size-4" aria-hidden /> Leads
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">Resultados de los leads</h1>
          <p className="text-sm text-muted-foreground">
            Los leads que entraron en el periodo (desde el día 1 del mes, en hora de España) y hasta
            dónde han llegado. «Cliente» es quien ya ha pagado.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={source} onValueChange={(v) => setSource(v as PlatformLeadSource | 'all')}>
            <SelectTrigger className="h-9 w-[200px]" aria-label="Origen">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los orígenes</SelectItem>
              {PLATFORM_LEAD_SOURCES.map((x) => (
                <SelectItem key={x} value={x}>
                  {PLATFORM_LEAD_SOURCE_LABELS[x]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(months)} onValueChange={(v) => setMonths(Number(v))}>
            <SelectTrigger className="h-9 w-[180px]" aria-label="Periodo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[3, 6, 12, 24].map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {`Este mes y los ${m - 1} anteriores`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {q.isError ? (
        <AdminError onRetry={() => void q.refetch()} />
      ) : !s ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Stat
              label="Leads"
              value={formatCount(s.leads)}
              change={delta(s.leads, s.previous.leads)}
            />
            <Stat
              label="Clientes"
              value={formatCount(customers)}
              change={delta(customers, s.previous.customers)}
            />
            <Stat
              label="Conversión"
              value={pct(customers, s.leads)}
              hint="de lead a cliente"
              change={delta(
                s.leads ? (customers / s.leads) * 100 : null,
                s.previous.conversionPct,
                { format: (n) => `${formatNumber(n, 1)} puntos` },
              )}
            />
            <Stat
              label="Pagan al mes"
              value={formatEur(s.mrr)}
              hint="los que son clientes, sin IVA"
              change={delta(s.mrr, s.previous.mrr, { format: formatEur })}
            />
            <Stat
              label="Primera respuesta"
              value={
                s.medianFirstResponseHours === null
                  ? '—'
                  : `${formatNumber(s.medianFirstResponseHours, 1)} h`
              }
              hint="mediana, de quien escribe solo"
              change={delta(s.medianFirstResponseHours, s.previous.medianFirstResponseHours, {
                higherIsBetter: false,
                format: (n) => `${formatNumber(n, 1)} h`,
              })}
            />
            <Stat
              label="Hasta pagar"
              value={
                s.avgDaysToCustomer === null
                  ? '—'
                  : `${formatNumber(s.avgDaysToCustomer, 1)} ${s.avgDaysToCustomer === 1 ? 'día' : 'días'}`
              }
              hint="media"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Hasta dónde llegan</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Los que trabajó el equipo, por las fases por las que pasaron de verdad.
                </p>
                {s.funnel.map((f) => (
                  <BarRow
                    key={f.stage}
                    label={PLATFORM_LEAD_STAGE_LABELS[f.stage]}
                    value={f.reached}
                    max={worked}
                    note={f.stage === 'new' ? undefined : `(${pct(f.reached, worked)})`}
                  />
                ))}
                <p className="pt-1 text-xs text-muted-foreground">
                  Entraron directamente en prueba (se registraron solos o se les creó la cuenta):{' '}
                  {formatCount(s.direct.leads)}
                  {s.direct.leads > 0
                    ? `, de los que ${plural(s.direct.customers, 'paga', 'pagan')} (${pct(s.direct.customers, s.direct.leads)})`
                    : ''}
                  .
                </p>
                <p className="text-xs text-muted-foreground">
                  {plural(s.lost, 'perdido', 'perdidos')} antes de pagar
                  {s.churned > 0
                    ? ` y ${plural(s.churned, 'cliente que se dio de baja', 'clientes que se dieron de baja')}`
                    : ''}
                  .
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Por qué se pierden</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {s.lostReasons.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Ninguno perdido en el periodo.</p>
                ) : (
                  s.lostReasons.map((r) => (
                    <BarRow
                      key={r.code}
                      label={PLATFORM_LEAD_LOST_REASON_LABELS[r.code] ?? r.code}
                      value={r.count}
                      max={s.lostReasons[0]!.count}
                    />
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                <CardTitle className="text-base">Días en cada fase</CardTitle>
                <CsvButton
                  filename="leads-dias-por-fase.csv"
                  rows={() => [
                    ['Fase', 'Días de media', 'Leads'],
                    ...s.stageDays.map((d) => [
                      PLATFORM_LEAD_STAGE_LABELS[d.stage],
                      d.avgDays ?? '',
                      d.count,
                    ]),
                  ]}
                />
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Cuánto tarda de media en pasar a la siguiente fase (de los que pasaron).
                </p>
                {s.stageDays.map((d) => (
                  <BarRow
                    key={d.stage}
                    label={PLATFORM_LEAD_STAGE_LABELS[d.stage]}
                    value={d.avgDays ?? 0}
                    max={Math.max(...s.stageDays.map((x) => x.avgDays ?? 0), 1)}
                    note={d.avgDays === null ? 'sin datos' : `días (${formatCount(d.count)})`}
                  />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                <CardTitle className="text-base">En juego ahora</CardTitle>
                <CsvButton
                  filename="leads-en-juego.csv"
                  rows={() => [
                    ['Fase', 'Leads abiertos', 'Cuota prevista al mes (sin IVA)'],
                    ...s.valueByStage.map((v) => [
                      PLATFORM_LEAD_STAGE_LABELS[v.stage],
                      v.leads,
                      v.value,
                    ]),
                  ]}
                />
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Lo que pagarían al mes (sin IVA) los leads abiertos hoy, por fase, según sus
                  trasteros o el plan que les interesa.
                </p>
                {s.valueByStage.map((v) => (
                  <div key={v.stage} className="flex justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">
                      {PLATFORM_LEAD_STAGE_LABELS[v.stage]} ({formatCount(v.leads)})
                    </span>
                    <span className="tabular-nums">{formatEur(v.value)}</span>
                  </div>
                ))}
                <div className="flex justify-between gap-2 border-t pt-1 text-sm font-medium">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatEur(s.valueByStage.reduce((a, v) => a + v.value, 0))}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            <GroupTable
              title="Por responsable"
              column="Responsable"
              csvName="leads-por-responsable.csv"
              rows={s.byAssignee}
            />
            <GroupTable
              title="Por campaña"
              column="Campaña"
              csvName="leads-por-campana.csv"
              rows={s.byCampaign}
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Descartados («No es un lead»)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {s.discardReasons.length === 0 ? (
                <p className="text-sm text-muted-foreground">Ninguno descartado en el periodo.</p>
              ) : (
                s.discardReasons.map((r) => (
                  <BarRow
                    key={r.code}
                    label={PLATFORM_LEAD_DISCARD_REASON_LABELS[r.code] ?? r.code}
                    value={r.count}
                    max={s.discardReasons[0]!.count}
                  />
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
              <CardTitle className="text-base">Por origen</CardTitle>
              <CsvButton
                filename="leads-por-origen.csv"
                disabled={s.bySource.length === 0}
                rows={() => [
                  ['Origen', 'Leads', 'Con cuenta', 'Clientes', 'Conversión (%)', 'Pagan al mes'],
                  ...s.bySource.map((r) => [
                    PLATFORM_LEAD_SOURCE_LABELS[r.source] ?? r.source,
                    r.leads,
                    r.trials,
                    r.customers,
                    r.conversionPct ?? '',
                    r.mrr,
                  ]),
                ]}
              />
            </CardHeader>
            <CardContent className="p-0">
              {s.bySource.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">Sin leads en el periodo.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="px-4 py-2 font-medium">Origen</th>
                        <th className="px-4 py-2 text-right font-medium">Leads</th>
                        <th className="px-4 py-2 text-right font-medium">Con cuenta</th>
                        <th className="px-4 py-2 text-right font-medium">Clientes</th>
                        <th className="px-4 py-2 text-right font-medium">Conversión</th>
                        <th className="px-4 py-2 text-right font-medium">Pagan al mes (sin IVA)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.bySource.map((r) => (
                        <tr key={r.source} className="border-b last:border-0">
                          <td className="px-4 py-2">
                            {PLATFORM_LEAD_SOURCE_LABELS[r.source] ?? r.source}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {formatCount(r.leads)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {formatCount(r.trials)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {formatCount(r.customers)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {r.conversionPct === null ? '—' : formatPct(r.conversionPct)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatEur(r.mrr)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

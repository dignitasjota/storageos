'use client';

import {
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_SOURCE_LABELS,
  PLATFORM_LEAD_STAGE_LABELS,
} from '@storageos/shared';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { AdminError } from '@/components/admin/admin-error';
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

const eur = (n: number) =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 1000) / 10} %` : '—';

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
        {value}
        {note ? <span className="ml-1 text-muted-foreground">{note}</span> : null}
      </span>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
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
  const q = useAdminLeadStats(months);
  const s = q.data;
  const customers = s?.funnel.find((f) => f.stage === 'customer')?.reached ?? 0;

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
            Los leads que entraron en el periodo y hasta dónde han llegado. «Cliente» es quien ya ha
            pagado.
          </p>
        </div>
        <Select value={String(months)} onValueChange={(v) => setMonths(Number(v))}>
          <SelectTrigger className="h-9 w-[180px]" aria-label="Periodo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[3, 6, 12, 24].map((m) => (
              <SelectItem key={m} value={String(m)}>
                Últimos {m} meses
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
            <Stat label="Leads" value={String(s.leads)} />
            <Stat label="Clientes" value={String(customers)} />
            <Stat label="Conversión" value={pct(customers, s.leads)} hint="de lead a cliente" />
            <Stat label="Pagan al mes" value={eur(s.mrr)} hint="los que son clientes" />
            <Stat
              label="Primera respuesta"
              value={s.medianFirstResponseHours === null ? '—' : `${s.medianFirstResponseHours} h`}
              hint="mediana"
            />
            <Stat
              label="Hasta pagar"
              value={s.avgDaysToCustomer === null ? '—' : `${s.avgDaysToCustomer} días`}
              hint="media"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Hasta dónde llegan</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {s.funnel.map((f) => (
                  <BarRow
                    key={f.stage}
                    label={PLATFORM_LEAD_STAGE_LABELS[f.stage]}
                    value={f.reached}
                    max={s.leads}
                    note={f.stage === 'new' ? undefined : `(${pct(f.reached, s.leads)})`}
                  />
                ))}
                <p className="pt-1 text-xs text-muted-foreground">
                  {s.lost} perdidos en el periodo.
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

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Por origen</CardTitle>
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
                        <th className="px-4 py-2 text-right font-medium">Pagan al mes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.bySource.map((r) => (
                        <tr key={r.source} className="border-b last:border-0">
                          <td className="px-4 py-2">
                            {PLATFORM_LEAD_SOURCE_LABELS[r.source] ?? r.source}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{r.leads}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{r.trials}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{r.customers}</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {r.conversionPct === null ? '—' : `${r.conversionPct} %`}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{eur(r.mrr)}</td>
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

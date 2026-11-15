'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { LeadFunnelRowDto } from '@storageos/shared';

import { SectionError } from '@/components/dashboard/section-state';
import { BackLink } from '@/components/layout/back-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadCsv } from '@/lib/csv';
import { useLeadReport } from '@/lib/leads/hooks';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PERIODS = [
  { value: '30', label: 'Últimos 30 días' },
  { value: '90', label: 'Últimos 90 días' },
  { value: '180', label: 'Últimos 6 meses' },
  { value: '365', label: 'Último año' },
];

const pct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('es-ES')} %`);

/** Embudo de los contactos que llegaron en el periodo: de dónde, quién y qué local. */
export default function LeadReportPage() {
  const [period, setPeriod] = useState('90');
  const from = isoDaysAgo(Number(period));
  const to = isoDaysAgo(0);
  const { data, isLoading, isError, refetch } = useLeadReport(from, to);

  const exportCsv = () => {
    if (!data) return;
    const header = [
      'Grupo',
      'Nombre',
      'Contactos',
      'Contactados',
      'Cualificados',
      'Ganados',
      'Perdidos',
      'Conversión %',
      'Días hasta ganar',
    ];
    const line = (group: string, r: LeadFunnelRowDto) => [
      group,
      r.label,
      r.leads,
      r.contacted,
      r.qualified,
      r.won,
      r.lost,
      r.conversionPct ?? '',
      r.avgDaysToWin ?? '',
    ];
    downloadCsv(`embudo-contactos-${from}-${to}.csv`, [
      header,
      line('Total', data.totals),
      ...data.bySource.map((r) => line('Origen', r)),
      ...data.byUser.map((r) => line('Responsable', r)),
      ...data.byFacility.map((r) => line('Local', r)),
    ]);
  };

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <BackLink href="/leads" label="Leads" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Informe de contactos</h1>
          <p className="text-sm text-muted-foreground">
            De los contactos que llegaron en el periodo: cuántos se atendieron, se cualificaron y
            acabaron alquilando, por origen, por responsable y por local.
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-44" aria-label="Periodo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={exportCsv} disabled={!data}>
            Descargar CSV
          </Button>
        </div>
      </div>

      {isError ? (
        <SectionError onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Contactos" value={data.totals.leads} />
            <Stat label="Atendidos" value={data.totals.contacted} />
            <Stat label="Cualificados" value={data.totals.qualified} />
            <Stat label="Ganados" value={data.totals.won} />
            <Stat
              label="Conversión"
              value={pct(data.totals.conversionPct)}
              hint={
                data.totals.avgDaysToWin !== null
                  ? `${data.totals.avgDaysToWin.toLocaleString('es-ES')} días de media`
                  : undefined
              }
            />
          </div>
          <FunnelTable title="Por origen" rows={data.bySource} />
          <FunnelTable title="Por responsable" rows={data.byUser} />
          {data.byFacility.length > 1 && <FunnelTable title="Por local" rows={data.byFacility} />}
          <p className="text-xs text-muted-foreground">
            ¿De dónde vienen las visitas a tu web? Míralo en{' '}
            <Link href="/marketing/web" className="underline">
              Marketing → Visitas de la web
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
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

function FunnelTable({ title, rows }: { title: string; rows: LeadFunnelRowDto[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin contactos en el periodo.</p>
        ) : (
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 font-medium" />
                <th className="py-2 text-right font-medium">Contactos</th>
                <th className="py-2 text-right font-medium">Atendidos</th>
                <th className="py-2 text-right font-medium">Cualificados</th>
                <th className="py-2 text-right font-medium">Ganados</th>
                <th className="py-2 text-right font-medium">Perdidos</th>
                <th className="py-2 text-right font-medium">Conversión</th>
                <th className="py-2 text-right font-medium">Días</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b last:border-0">
                  <td className="py-2">{r.label}</td>
                  <td className="py-2 text-right tabular-nums">{r.leads}</td>
                  <td className="py-2 text-right tabular-nums">{r.contacted}</td>
                  <td className="py-2 text-right tabular-nums">{r.qualified}</td>
                  <td className="py-2 text-right tabular-nums">{r.won}</td>
                  <td className="py-2 text-right tabular-nums">{r.lost}</td>
                  <td className="py-2 text-right tabular-nums">{pct(r.conversionPct)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {r.avgDaysToWin === null ? '—' : r.avgDaysToWin.toLocaleString('es-ES')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

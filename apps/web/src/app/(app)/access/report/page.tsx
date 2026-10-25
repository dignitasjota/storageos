'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate, formatNumber } from '@/lib/format';
import { useAccessReport } from '@/lib/operations/features-hooks';

const REASONS: Record<string, string> = {
  denied_invalid_credential: 'Código no válido',
  denied_inactive_credential: 'Acceso suspendido',
  denied_outside_hours: 'Fuera de horario',
  denied_wrong_facility: 'Otro local',
  denied_dunning: 'Cortado por impago',
  denied_unknown: 'Denegado',
  error: 'Error',
};

/** Informe de entradas: por día, por hora, quién entra más y quién falla. */
export default function AccessReportPage() {
  const [days, setDays] = useState(30);
  const facilityId = useHeaderFacilityId();
  const report = useAccessReport(days, facilityId);
  const r = report.data;
  const maxDay = Math.max(1, ...(r?.byDay ?? []).map((d) => d.allowed + d.denied));
  const maxHour = Math.max(1, ...(r?.byHour ?? []));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[7, 30, 90].map((d) => (
          <Button
            key={d}
            size="sm"
            variant={days === d ? 'default' : 'outline'}
            onClick={() => setDays(d)}
          >
            Últimos {d} días
          </Button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Entradas" value={r ? formatNumber(r.totals.allowed) : '—'} />
        <Stat label="Denegadas" value={r ? formatNumber(r.totals.denied) : '—'} />
        <Stat
          label="Inquilinos distintos"
          value={r ? formatNumber(r.totals.uniqueCustomers) : '—'}
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Por día</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-40 items-end gap-px" role="img" aria-label="Accesos por día">
            {(r?.byDay ?? []).map((d) => (
              <div
                key={d.date}
                className="group relative flex h-full flex-1 flex-col justify-end"
                title={`${formatDate(d.date)}: ${d.allowed} entradas, ${d.denied} denegadas`}
              >
                <div
                  className="rounded-t-sm bg-red-500/70"
                  style={{ height: `${(d.denied / maxDay) * 100}%` }}
                />
                <div className="bg-primary" style={{ height: `${(d.allowed / maxDay) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-sm bg-primary" /> Entradas
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-sm bg-red-500/70" /> Denegadas
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Por hora del día</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-28 items-end gap-1" role="img" aria-label="Entradas por hora">
            {(r?.byHour ?? []).map((n, h) => (
              <div
                key={h}
                className="flex h-full flex-1 flex-col justify-end"
                title={`${String(h).padStart(2, '0')}:00 — ${n} entradas`}
              >
                <div
                  className="rounded-t-sm bg-primary"
                  style={{ height: `${(n / maxHour) * 100}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-muted-foreground">
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Quién entra más</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {(r?.topCustomers ?? []).length === 0 && (
              <p className="text-muted-foreground">Sin entradas en el periodo.</p>
            )}
            {(r?.topCustomers ?? []).map((c) => (
              <div key={c.customerId} className="flex justify-between gap-2">
                <Link href={`/customers/${c.customerId}`} className="hover:underline">
                  {c.customerName}
                </Link>
                <span className="tabular-nums text-muted-foreground">{c.visits}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Más denegaciones</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {(r?.topDenied ?? []).length === 0 && (
              <p className="text-muted-foreground">Ninguna en el periodo.</p>
            )}
            {(r?.topDenied ?? []).map((d, i) => (
              <div key={`${d.customerId ?? 'x'}-${i}`} className="flex justify-between gap-2">
                <span>
                  {d.customerId ? (
                    <Link href={`/customers/${d.customerId}`} className="hover:underline">
                      {d.customerName}
                    </Link>
                  ) : (
                    d.customerName
                  )}
                  <span className="block text-xs text-muted-foreground">
                    {REASONS[d.reason] ?? d.reason}
                  </span>
                </span>
                <span className="tabular-nums text-muted-foreground">{d.denied}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

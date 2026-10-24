'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { AdminCalendarChargeDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminBillingCalendar } from '@/lib/admin/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const METHOD: Record<string, string> = {
  stripe: 'Stripe',
  sepa: 'SEPA',
  redsys: 'Tarjeta (Redsys)',
  manual: 'Manual',
};
const STATE: Record<AdminCalendarChargeDto['state'], { label: string; className: string }> = {
  scheduled: { label: 'Previsto', className: 'bg-muted text-foreground' },
  paid: {
    label: 'Cobrado',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  failed: {
    label: 'Fallido',
    className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
  bounced: {
    label: 'Devuelto',
    className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
};
const RANGES = [30, 60, 90] as const;

/** Lunes de la semana de una fecha (clave para agrupar). */
function weekStart(iso: string): string {
  const d = new Date(iso);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Calendario de cobros a los tenants: lo previsto en los próximos días (cuota
 * con sus extras y extras de pago manual) y lo cobrado, fallido o devuelto en
 * las dos últimas semanas, agrupado por semanas.
 */
export default function BillingCalendarPage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(60);
  const cal = useAdminBillingCalendar(days, 14);

  const weeks = useMemo(() => {
    const groups = new Map<string, AdminCalendarChargeDto[]>();
    for (const c of cal.data?.charges ?? []) {
      const k = weekStart(c.date);
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    return [...groups.entries()];
  }, [cal.data]);

  if (cal.isError) return <AdminError onRetry={() => void cal.refetch()} />;
  const by = cal.data?.scheduledByMethod;
  const scheduledTotal = by ? by.stripe + by.sepa + (by.redsys ?? 0) + by.manual : 0;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calendario de cobros</h1>
          <p className="text-sm text-muted-foreground">
            Lo que se cobrará a los tenants y lo cobrado en las dos últimas semanas
            {cal.data ? ` (${cal.data.pricesIncludeVat ? 'IVA incluido' : 'con IVA'})` : ''}.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setDays(r)}
              className={`rounded px-3 py-1 text-sm ${days === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
            >
              {r} días
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Kpi label={`Previsto ${days} días`} value={eur(scheduledTotal)} />
        <Kpi label="Por Stripe" value={eur(by?.stripe ?? 0)} />
        <Kpi label="Por SEPA" value={eur(by?.sepa ?? 0)} />
        <Kpi label="Manual" value={eur(by?.manual ?? 0)} />
      </div>

      {cal.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : weeks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No hay cobros en este periodo.
          </CardContent>
        </Card>
      ) : (
        weeks.map(([week, list]) => {
          const scheduled = list.filter((c) => c.state === 'scheduled');
          const total = scheduled.reduce((s, c) => s + c.amount, 0);
          return (
            <Card key={week}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm">
                  <span>
                    Semana del{' '}
                    {new Date(week).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}
                  </span>
                  {scheduled.length > 0 && (
                    <span className="font-normal text-muted-foreground">Previsto {eur(total)}</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y">
                  {list.map((c, i) => (
                    <li
                      key={`${c.tenantId}-${c.date}-${i}`}
                      className="flex items-center gap-3 px-4 py-2 text-sm"
                    >
                      <span className="w-20 shrink-0 text-xs text-muted-foreground">
                        {new Date(c.date).toLocaleDateString('es-ES', {
                          weekday: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/admin/tenants/${c.tenantId}?tab=payments`}
                          className="font-medium hover:underline"
                        >
                          {c.tenantName}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">{c.concept}</p>
                      </div>
                      <Badge variant="outline" className="hidden sm:inline-flex">
                        {METHOD[c.method] ?? c.method}
                      </Badge>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${STATE[c.state].className}`}>
                        {STATE[c.state].label}
                      </span>
                      <span className="w-20 shrink-0 text-right tabular-nums">{eur(c.amount)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

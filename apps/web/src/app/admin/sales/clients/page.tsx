'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import {
  Empty,
  PageHeader,
  ProfileGlance,
  QueryError,
  relativeDays,
  SalesPage,
  Stat,
  TemperatureBadge,
  TenantStatusBadge,
} from '@/components/admin/sales/common';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useSalesClients } from '@/lib/admin/sales-hooks';
import { formatEur } from '@/lib/format';
import { cn } from '@/lib/utils';

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Todos' },
  { value: 'trial', label: 'En prueba' },
  { value: 'trial_ending', label: 'Prueba que acaba' },
  { value: 'paying', label: 'Pagando' },
  { value: 'past_due', label: 'Pago pendiente' },
  { value: 'onboarding', label: 'Sin arrancar' },
  { value: 'no_contact', label: 'Sin contacto hace tiempo' },
];

const HEALTH_CLASS: Record<string, string> = {
  healthy: 'text-emerald-700 dark:text-emerald-400',
  warm: 'text-amber-700 dark:text-amber-400',
  at_risk: 'text-rose-700 dark:text-rose-400',
  dormant: 'text-rose-700 dark:text-rose-400',
};

export default function SalesClientsPage() {
  const [filter, setFilter] = useState('');
  const clients = useSalesClients(filter || undefined);
  const all = useSalesClients();
  const rows = clients.data ?? [];
  const base = all.data ?? [];
  const mrr = base
    .filter((c) => c.firstPaidAt && c.status === 'active')
    .reduce((s, c) => s + c.monthly, 0);

  return (
    <SalesPage>
      <PageHeader
        title="Clientes"
        description="Las cuentas que son tuyas: sus pruebas, lo que pagan y cómo las usan."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Cuentas" value={base.length} />
        <Stat label="En prueba" value={base.filter((c) => c.status === 'trial').length} />
        <Stat
          label="Pagando"
          value={base.filter((c) => c.firstPaidAt && c.status === 'active').length}
        />
        <Stat label="Pagan al mes" value={formatEur(mrr)} tone="good" />
      </div>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value || 'all'}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs',
              filter === f.value
                ? 'border-primary bg-primary/10 text-primary'
                : 'text-muted-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {clients.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : clients.isError ? (
        <QueryError query={clients} />
      ) : rows.length === 0 ? (
        <Empty>No hay clientes con este filtro.</Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Al mes</TableHead>
                <TableHead className="hidden md:table-cell">Uso</TableHead>
                <TableHead className="hidden lg:table-cell">Último acceso</TableHead>
                <TableHead className="hidden lg:table-cell">Siguiente paso</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.tenantId}>
                  <TableCell>
                    <Link
                      href={`/admin/sales/accounts/${c.leadId}`}
                      className="font-medium hover:underline"
                    >
                      {c.name}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {c.planName && <span>{c.planName}</span>}
                      {c.addons.length > 0 && <span>· {c.addons.join(', ')}</span>}
                      <TemperatureBadge value={c.profile?.temperature} />
                    </div>
                    <ProfileGlance profile={c.profile} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <TenantStatusBadge status={c.status} pastDue={c.pastDue} />
                      {c.trialDaysLeft !== null && (
                        <span
                          className={cn(
                            'text-xs',
                            c.trialDaysLeft <= 3
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-muted-foreground',
                          )}
                        >
                          {c.trialDaysLeft >= 0
                            ? `Le quedan ${c.trialDaysLeft} días`
                            : 'Prueba acabada'}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatEur(c.monthly)}</TableCell>
                  <TableCell className="hidden text-xs md:table-cell">
                    {c.units} trasteros
                    {c.unitsLimit !== null && ` de ${c.unitsLimit}`} · {c.contracts} contratos
                    {c.healthScore !== null && (
                      <span className={cn('block', HEALTH_CLASS[c.healthLevel ?? ''] ?? '')}>
                        Salud {c.healthScore}/100
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                    {relativeDays(c.lastLoginAt)}
                  </TableCell>
                  <TableCell className="hidden text-xs lg:table-cell">
                    {c.nextFollowup ? (
                      <>
                        {c.nextFollowup.title}
                        <span className="block text-muted-foreground">
                          {relativeDays(c.nextFollowup.dueDate)}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SalesPage>
  );
}

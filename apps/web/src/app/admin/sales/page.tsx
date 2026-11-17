'use client';

import { CheckCircle2, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { SalesTodayRowDto } from '@storageos/shared';

import {
  Empty,
  errorText,
  PageHeader,
  relativeDays,
  SalesPage,
  Stat,
} from '@/components/admin/sales/common';
import { NewProspectDialog } from '@/components/admin/sales/new-prospect-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSalesToday, useUpdateSalesFollowup } from '@/lib/admin/sales-hooks';
import { formatDate, formatEur } from '@/lib/format';
import { cn } from '@/lib/utils';

function RowList({
  title,
  rows,
  empty,
  tone,
}: {
  title: string;
  rows: SalesTodayRowDto[];
  empty: string;
  tone?: 'warn' | 'bad';
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          {title}
          {rows.length > 0 && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs',
                tone === 'bad'
                  ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                  : tone === 'warn'
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {rows.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y">
            {rows.slice(0, 8).map((r) => (
              <li key={`${r.leadId}-${r.detail}`} className="py-2">
                <Link
                  href={`/admin/sales/accounts/${r.leadId}`}
                  className="block rounded-md hover:bg-accent/40"
                >
                  <p className="text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.detail}
                    {r.date && ` · ${formatDate(r.date)}`}
                  </p>
                </Link>
              </li>
            ))}
            {rows.length > 8 && (
              <li className="pt-2 text-xs text-muted-foreground">Y {rows.length - 8} más.</li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function SalesTodayPage() {
  const today = useSalesToday();
  const done = useUpdateSalesFollowup();
  const [newOpen, setNewOpen] = useState(false);
  const data = today.data;

  async function markDone(id: string) {
    try {
      await done.mutateAsync({ id, input: { status: 'done' } });
      toast.success('Seguimiento hecho.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <SalesPage>
      <PageHeader
        title="Hoy"
        description={data ? formatDate(data.date) : undefined}
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="mr-1.5 size-4" />
            Nuevo prospecto
          </Button>
        }
      />
      <NewProspectDialog open={newOpen} onClose={() => setNewOpen(false)} />

      {today.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      )}
      {today.isError && <Empty>No se ha podido cargar. Vuelve a intentarlo en un momento.</Empty>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Stat label="Prospectos" value={data.kpis.prospects} />
            <Stat label="En prueba" value={data.kpis.trials} />
            <Stat label="Clientes" value={data.kpis.customers} />
            <Stat label="Pagan al mes" value={formatEur(data.kpis.mrr)} />
            <Stat
              label="Clientes nuevos este mes"
              value={
                data.kpis.target
                  ? `${data.kpis.newClientsMonth} / ${data.kpis.target.newClients}`
                  : data.kpis.newClientsMonth
              }
              hint={`${formatEur(data.kpis.newMrrMonth)} al mes`}
              tone={
                data.kpis.target && data.kpis.newClientsMonth >= data.kpis.target.newClients
                  ? 'good'
                  : 'default'
              }
            />
            <Stat
              label="Comisión del mes"
              value={formatEur(data.kpis.commissionMonth)}
              tone="good"
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Seguimientos para hoy</CardTitle>
            </CardHeader>
            <CardContent>
              {data.followups.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nada pendiente para hoy.</p>
              ) : (
                <ul className="divide-y">
                  {data.followups.map((f) => (
                    <li key={f.id} className="flex items-start gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/admin/sales/accounts/${f.leadId}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {f.leadName}
                        </Link>
                        <p className="text-sm">{f.title}</p>
                        {f.note && <p className="text-xs text-muted-foreground">{f.note}</p>}
                        <p
                          className={cn(
                            'text-xs',
                            f.overdue
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-muted-foreground',
                          )}
                        >
                          {f.overdue ? `Atrasado (${relativeDays(f.dueDate)})` : 'Hoy'}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={done.isPending}
                        onClick={() => void markDone(f.id)}
                      >
                        <CheckCircle2 className="mr-1.5 size-4" />
                        Hecho
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <RowList
              title="Altas con tu código"
              rows={data.newSignups}
              empty="Ninguna alta nueva en los últimos días."
            />
            <RowList
              title="Pruebas que acaban"
              rows={data.trialsEnding}
              empty="Ninguna prueba acaba esta semana."
              tone="warn"
            />
            <RowList
              title="Pagos pendientes"
              rows={data.pastDue}
              empty="Todos tus clientes están al día."
              tone="bad"
            />
            <RowList
              title="Pruebas sin arrancar"
              rows={data.stuckOnboarding}
              empty="Todas tus pruebas ya tienen trasteros y contratos."
              tone="warn"
            />
            <RowList
              title="Propuestas sin respuesta"
              rows={data.offersPending}
              empty="No tienes propuestas esperando."
            />
            <RowList
              title="Sin contacto hace tiempo"
              rows={data.noContact}
              empty="Has hablado con todos hace poco."
            />
          </div>
        </>
      )}
    </SalesPage>
  );
}

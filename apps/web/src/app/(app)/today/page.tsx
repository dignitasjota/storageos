'use client';

import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  ClipboardList,
  CreditCard,
  DoorOpen,
  FileSignature,
  LogOut,
  MessageSquare,
  Replace,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import type { TodayItemDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useToday } from '@/lib/dashboard/hooks';
import { useUpdateFollowup } from '@/lib/followups/hooks';
import { useTransitionTask } from '@/lib/operations/hooks';

function eur(n: number): string {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

/** Una tarjeta de "pendientes" con su lista, enlaces y acción inline opcional. */
function SectionCard({
  title,
  icon: Icon,
  count,
  items,
  href,
  itemHref,
  empty,
  onComplete,
  completeLabel,
}: {
  title: string;
  icon: typeof ClipboardList;
  count: number;
  items: TodayItemDto[];
  href: string;
  itemHref: (it: TodayItemDto) => string;
  empty: string;
  onComplete?: (it: TodayItemDto) => void;
  completeLabel?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-muted-foreground" /> {title}
          {count > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
              {count}
            </span>
          )}
        </CardTitle>
        <Link
          href={href}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Ver todo <ArrowRight className="size-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((it) => (
              <li key={it.id} className="flex items-center gap-1">
                <Link
                  href={itemHref(it)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{it.label}</span>
                    {it.detail && (
                      <span className="shrink-0 text-xs text-muted-foreground">{it.detail}</span>
                    )}
                  </span>
                  {it.date && (
                    <span
                      className={`shrink-0 text-xs ${it.overdue ? 'font-medium text-red-600' : 'text-muted-foreground'}`}
                    >
                      {it.overdue ? 'Atrasado · ' : ''}
                      {fmtDate(it.date)}
                    </span>
                  )}
                </Link>
                {onComplete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground hover:text-green-600"
                    title={completeLabel ?? 'Marcar hecho'}
                    onClick={() => onComplete(it)}
                  >
                    <Check className="size-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Una métrica simple clicable (sin lista). */
function StatTile({
  label,
  value,
  icon: Icon,
  href,
  highlight,
}: {
  label: string;
  value: string;
  icon: typeof CreditCard;
  href: string;
  highlight?: boolean;
}) {
  return (
    <Link href={href}>
      <Card className={highlight ? 'border-amber-300' : undefined}>
        <CardContent className="flex items-center gap-3 pt-6">
          <span
            className={`flex size-10 shrink-0 items-center justify-center rounded-full ${highlight ? 'bg-amber-100 text-amber-600' : 'bg-muted text-muted-foreground'}`}
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xl font-semibold tracking-tight">{value}</p>
            <p className="truncate text-xs text-muted-foreground">{label}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function TodayPage() {
  const { data, isLoading } = useToday();
  const canTasks = useHasPermission('tasks:write');
  const canFollowups = useHasPermission('customers:write');
  const transitionTask = useTransitionTask();
  const updateFollowup = useUpdateFollowup();

  async function completeTask(it: TodayItemDto) {
    try {
      await transitionTask.mutateAsync({ id: it.id, input: { status: 'done' } });
      toast.success('Tarea completada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }
  async function completeFollowup(it: TodayItemDto) {
    try {
      await updateFollowup.mutateAsync({ id: it.id, status: 'done' });
      toast.success('Seguimiento marcado como hecho.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const todayLabel = new Date().toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Hoy</h1>
        <p className="text-sm capitalize text-muted-foreground">
          {todayLabel}
          {data && data.urgentCount > 0 && (
            <span className="ml-1 font-medium text-amber-600">
              · {data.urgentCount} {data.urgentCount === 1 ? 'cosa urgente' : 'cosas urgentes'}
            </span>
          )}
        </p>
      </div>

      {isLoading || !data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          {/* Entradas y salidas de hoy - lo mas operativo del dia */}
          <div className="grid gap-3 lg:grid-cols-2">
            <SectionCard
              title="Entradas de hoy"
              icon={DoorOpen}
              count={data.moveInsToday.count}
              items={data.moveInsToday.items}
              href="/contracts"
              itemHref={(it) => `/contracts/${it.id}`}
              empty="Ningún inquilino entra hoy."
            />
            <SectionCard
              title="Salidas de hoy"
              icon={LogOut}
              count={data.moveOutsToday.count}
              items={data.moveOutsToday.items}
              href="/contracts"
              itemHref={(it) => `/contracts/${it.id}`}
              empty="Ninguna salida (check-out) hoy."
            />
          </div>

          {/* Metricas rapidas */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatTile
              label="Vencen hoy"
              value={
                data.invoicesDueToday.count > 0
                  ? `${data.invoicesDueToday.count} · ${eur(data.invoicesDueToday.totalDue)}`
                  : '0'
              }
              icon={CreditCard}
              href="/invoices"
              highlight={data.invoicesDueToday.count > 0}
            />
            <StatTile
              label="Facturas vencidas"
              value={
                data.invoicesOverdue.count > 0
                  ? `${data.invoicesOverdue.count} · ${eur(data.invoicesOverdue.totalPending)}`
                  : '0'
              }
              icon={CreditCard}
              href="/invoices"
              highlight={data.invoicesOverdue.count > 0}
            />
            <StatTile
              label="Incidencias abiertas"
              value={String(data.incidentsOpen)}
              icon={AlertTriangle}
              href="/incidents"
              highlight={data.incidentsOpen > 0}
            />
            <StatTile
              label="Cambios de trastero"
              value={String(data.unitChangesPending)}
              icon={Replace}
              href="/unit-change-requests"
              highlight={data.unitChangesPending > 0}
            />
            <StatTile
              label="Mensajes sin leer"
              value={String(data.unreadMessages)}
              icon={MessageSquare}
              href="/customers"
              highlight={data.unreadMessages > 0}
            />
          </div>

          {/* Bandeja de trabajo con acciones inline */}
          <div className="grid gap-3 lg:grid-cols-3">
            <SectionCard
              title="Tareas para hoy"
              icon={ClipboardList}
              count={data.tasksDue.count}
              items={data.tasksDue.items}
              href="/tasks"
              itemHref={() => '/tasks'}
              empty="Sin tareas pendientes para hoy."
              onComplete={canTasks ? completeTask : undefined}
              completeLabel="Completar tarea"
            />
            <SectionCard
              title="Seguimientos"
              icon={CalendarClock}
              count={data.followupsDue.count}
              items={data.followupsDue.items}
              href="/followups"
              itemHref={(it) => (it.linkId ? `/customers/${it.linkId}` : '/followups')}
              empty="Sin seguimientos para hoy."
              onComplete={canFollowups ? completeFollowup : undefined}
              completeLabel="Marcar hecho"
            />
            <SectionCard
              title="Leads sin contactar"
              icon={Sparkles}
              count={data.newLeads.count}
              items={data.newLeads.items}
              href="/leads"
              itemHref={() => '/leads'}
              empty="Ningún lead nuevo sin contactar."
            />
            <SectionCard
              title="Firmas pendientes"
              icon={FileSignature}
              count={data.signaturesPending.count}
              items={data.signaturesPending.items}
              href="/contracts"
              itemHref={(it) => `/contracts/${it.id}`}
              empty="Ningún contrato pendiente de firma."
            />
            <SectionCard
              title="Contratos por vencer"
              icon={CalendarClock}
              count={data.contractsEndingSoon.count}
              items={data.contractsEndingSoon.items}
              href="/renewals"
              itemHref={(it) => `/contracts/${it.id}`}
              empty="Ningún contrato vence en 30 días."
            />
            <SectionCard
              title="Reservas que expiran"
              icon={UserPlus}
              count={data.reservationsExpiring.count}
              items={data.reservationsExpiring.items}
              href="/reservations"
              itemHref={() => '/reservations'}
              empty="Ninguna reserva expira en 7 días."
            />
          </div>
        </>
      )}
    </div>
  );
}

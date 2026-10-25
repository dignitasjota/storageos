'use client';

import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  ClipboardList,
  Lock,
  CreditCard,
  DoorOpen,
  FileSignature,
  HeartHandshake,
  LogOut,
  MessageSquare,
  PiggyBank,
  Radio,
  Replace,
  Sparkles,
  UserPlus,
  Timer,
  FileWarning,
  Package,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import type { TodayActivityDto, TodayActivityKind, TodayItemDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { MonthStrip } from '@/components/dashboard/month-strip';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useBulkRemindInvoices, useChargeInvoice } from '@/lib/billing/hooks';
import { useRenewContract, useRequestSignature } from '@/lib/customers/hooks';
import { useToday, useTodaySummary } from '@/lib/dashboard/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
import { useUpdateFollowup } from '@/lib/followups/hooks';
import { useUpdateLeadFollowup } from '@/lib/leads/hooks';
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
  renderActions,
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
  /** Botones propios de cada fila (cobrar, reenviar, prorrogar…). */
  renderActions?: (it: TodayItemDto) => ReactNode;
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
                    {it.amount !== undefined && (
                      <span className="shrink-0 text-xs font-medium tabular-nums">
                        {eur(it.amount)}
                      </span>
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
                {renderActions?.(it)}
                {onComplete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground hover:text-green-600"
                    title={completeLabel ?? 'Marcar hecho'}
                    onClick={() => onComplete(it)}
                    aria-label="Marcar como hecho"
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

function TabCount({ n, neutral }: { n: number; neutral?: boolean }) {
  if (n <= 0) return null;
  return (
    <span
      className={`ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium ${neutral ? 'bg-muted text-muted-foreground' : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'}`}
    >
      {n}
    </span>
  );
}

const ACTIVITY_ICON: Record<TodayActivityKind, typeof CreditCard> = {
  contract_signed: FileSignature,
  payment_received: CreditCard,
  payment_failed: AlertTriangle,
  move_out_requested: LogOut,
  lead_created: Sparkles,
  customer_message: MessageSquare,
  incident_reported: AlertTriangle,
};

/** Lo que ha pasado en las últimas 48 h. */
function ActivityList({ items }: { items: TodayActivityDto[] | null }) {
  if (!items) return <Skeleton className="h-40" />;
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Nada nuevo en las últimas 48 horas.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y">
          {items.map((a, i) => {
            const Icon = ACTIVITY_ICON[a.kind];
            const bad = a.kind === 'payment_failed' || a.kind === 'move_out_requested';
            return (
              <li key={`${a.kind}-${a.at}-${i}`}>
                <Link href={a.href} className="flex items-start gap-3 px-4 py-3 hover:bg-muted">
                  <Icon
                    className={`mt-0.5 size-4 shrink-0 ${bad ? 'text-red-600' : 'text-muted-foreground'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{a.label}</span>
                    {a.detail && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {a.detail}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(a.at).toLocaleString('es-ES', {
                      weekday: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
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
            className={`flex size-10 shrink-0 items-center justify-center rounded-full ${highlight ? 'bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-300' : 'bg-muted text-muted-foreground'}`}
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

const MINE_KEY = 'storageos.today.mine';

export default function TodayPage() {
  const [facilityFilterId, setFacilityFilterId] = useFacilityFilterState();
  const facilityId = facilityFilterId ?? 'all';
  const setFacilityId = (v: string) => setFacilityFilterId(v === 'all' ? undefined : v);
  const facilities = useFacilities();
  // «Lo mío» se recuerda en este navegador.
  const [mine, setMine] = useState(false);
  useEffect(() => {
    try {
      setMine(window.localStorage.getItem(MINE_KEY) === '1');
    } catch {
      /* almacenamiento no disponible */
    }
  }, []);
  function changeMine(next: boolean) {
    setMine(next);
    try {
      window.localStorage.setItem(MINE_KEY, next ? '1' : '0');
    } catch {
      /* almacenamiento no disponible */
    }
  }
  const { data, isLoading } = useToday(facilityId === 'all' ? undefined : facilityId, mine);
  const summary = useTodaySummary(facilityId === 'all' ? undefined : facilityId);
  const [tab, setTab] = useState('collections');
  const counts = data
    ? {
        collections:
          data.invoicesDueToday.count +
          data.invoicesOverdue.count +
          data.collectionsDeadlines.count +
          data.depositsToSettle.count +
          data.depositsToRegister.count +
          data.depositsToCollect.count,
        operations:
          data.moveInsToday.count +
          data.moveOutsToday.count +
          data.tasksDue.count +
          data.signaturesPending.count +
          data.contractsEndingSoon.count +
          data.reservationsExpiring.count +
          data.incidentsOpen +
          data.unitChangesPending +
          (data.lowStock?.count ?? 0) +
          (data.unitsOutOfService?.count ?? 0) +
          (data.facilityDocumentsExpiring?.count ?? 0),
        sales:
          // Los contactos sin atender ya están entre los nuevos: no se suman dos veces.
          data.newLeads.count +
          data.followupsDue.count +
          (data.leadFollowupsDue?.count ?? 0) +
          data.unreadMessages +
          data.retentionOffersPending.count +
          data.marketingRenewalsDue.count,
      }
    : { collections: 0, operations: 0, sales: 0 };
  const canTasks = useHasPermission('tasks:write');
  const canFollowups = useHasPermission('customers:write');
  const transitionTask = useTransitionTask();
  const updateFollowup = useUpdateFollowup();
  const updateLeadFollowup = useUpdateLeadFollowup();
  const canLeads = useHasPermission('leads:write');
  const canCharge = useHasPermission('payments:charge');
  const canRemind = useHasPermission('communications:send');
  const canSign = useHasPermission('contracts:write');
  const canRenew = useHasPermission('contracts:manage');
  const charge = useChargeInvoice();
  const remind = useBulkRemindInvoices();
  const resend = useRequestSignature();
  const renew = useRenewContract();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    } finally {
      setBusy(null);
    }
  }
  function chargeNow(it: TodayItemDto) {
    void run(`charge-${it.id}`, async () => {
      if (
        !(await confirm({
          title: `¿Cobrar ${eur(it.amount ?? 0)} a ${it.label}?`,
          description: 'Se cobra con su tarjeta o domiciliación guardada.',
          confirmLabel: 'Cobrar',
        }))
      )
        return;
      const p = await charge.mutateAsync({ invoiceId: it.id, input: {} });
      if (p.status === 'succeeded') toast.success('Cobrado.');
      else if (p.status === 'processing')
        toast.success('Cobro en curso: se confirmará en unos días.');
      else toast.error(p.failureReason ?? 'El cobro ha sido rechazado.');
    });
  }
  function remindNow(it: TodayItemDto) {
    void run(`remind-${it.id}`, async () => {
      const r = await remind.mutateAsync([it.id]);
      if (r.succeeded.length > 0) toast.success(`Recordatorio enviado a ${it.label}.`);
      else toast.error(r.failed[0]?.error ?? 'No se pudo enviar el recordatorio.');
    });
  }
  function resendNow(it: TodayItemDto) {
    void run(`sign-${it.id}`, async () => {
      const r = await resend.mutateAsync(it.id);
      toast.success(
        r.emailed ? 'Enlace de firma reenviado por correo.' : 'Enlace nuevo creado (sin email).',
      );
    });
  }
  function renewNow(it: TodayItemDto) {
    void run(`renew-${it.id}`, async () => {
      if (
        !(await confirm({
          title: `¿Prorrogar 12 meses el contrato de ${it.label}?`,
          description: 'La fecha de fin se alarga un año y el contrato sigue facturando.',
          confirmLabel: 'Prorrogar',
        }))
      )
        return;
      await renew.mutateAsync({ id: it.id, body: { months: 12 } });
      toast.success('Contrato prorrogado 12 meses.');
    });
  }
  const rowButton = (key: string, label: string, onClick: () => void) => (
    <Button
      variant="outline"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      disabled={busy !== null}
      onClick={onClick}
    >
      {busy === key ? '…' : label}
    </Button>
  );
  const invoiceActions = (it: TodayItemDto) => (
    <>
      {canCharge &&
        it.chargeable &&
        (it.amount ?? 0) > 0 &&
        rowButton(`charge-${it.id}`, 'Cobrar', () => chargeNow(it))}
      {canRemind && it.overdue && rowButton(`remind-${it.id}`, 'Recordar', () => remindNow(it))}
    </>
  );

  async function completeTask(it: TodayItemDto) {
    try {
      await transitionTask.mutateAsync({ id: it.id, input: { status: 'done' } });
      toast.success('Tarea completada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }
  async function completeLeadFollowup(it: TodayItemDto) {
    try {
      await updateLeadFollowup.mutateAsync({ id: it.id, status: 'done' });
      toast.success('Seguimiento marcado como hecho.');
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

  const rawToday = new Date().toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const todayLabel = rawToday.charAt(0).toUpperCase() + rawToday.slice(1);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hoy</h1>
          <p className="text-sm text-muted-foreground">
            {todayLabel}
            {data && data.urgentCount > 0 && (
              <span className="ml-1 font-medium text-amber-600">
                · {data.urgentCount} {data.urgentCount === 1 ? 'cosa urgente' : 'cosas urgentes'}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Qué ver">
            <Button
              size="sm"
              variant={mine ? 'ghost' : 'secondary'}
              className="h-7"
              onClick={() => changeMine(false)}
              aria-pressed={!mine}
            >
              Todo el equipo
            </Button>
            <Button
              size="sm"
              variant={mine ? 'secondary' : 'ghost'}
              className="h-7"
              onClick={() => changeMine(true)}
              aria-pressed={mine}
            >
              Lo mío
            </Button>
          </div>
          <Button asChild size="sm" variant="outline" className="h-8">
            <Link href="/today/desk">Modo mostrador</Link>
          </Button>
          {(facilities.data?.length ?? 0) > 1 && (
            <Select value={facilityId} onValueChange={setFacilityId}>
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue placeholder="Todos los locales" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los locales</SelectItem>
                {facilities.data?.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {mine && (
        <p className="text-xs text-muted-foreground">
          Lo mío: tareas e incidencias asignadas a ti, tus contactos y los seguimientos que creaste.
          Cobros, entradas y salidas son de todo el equipo.
        </p>
      )}

      {facilityId !== 'all' && (
        <p className="text-xs text-muted-foreground">
          Filtrado por local. Los leads, seguimientos y mensajes se muestran de toda la empresa (no
          están asociados a un local).
        </p>
      )}

      {isLoading || !data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          <MonthStrip summary={summary.data} />
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="collections">
                Cobros <TabCount n={counts.collections} />
              </TabsTrigger>
              <TabsTrigger value="operations">
                Operación <TabCount n={counts.operations} />
              </TabsTrigger>
              <TabsTrigger value="sales">
                Comercial <TabCount n={counts.sales} />
              </TabsTrigger>
              <TabsTrigger value="activity">
                Actividad <TabCount n={summary.data?.activity.length ?? 0} neutral />
              </TabsTrigger>
            </TabsList>

            <TabsContent value="collections" className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                {(summary.data?.kpis.debtorsWithoutPortal ?? 0) > 0 && (
                  <StatTile
                    label="Con deuda y nunca han entrado en el portal"
                    value={String(summary.data!.kpis.debtorsWithoutPortal)}
                    icon={CreditCard}
                    href="/customers?f=overdue,noPortal"
                  />
                )}
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <SectionCard
                  title={`Vencen hoy · ${eur(data.invoicesDueToday.totalDue)}`}
                  icon={CreditCard}
                  count={data.invoicesDueToday.count}
                  items={data.invoicesDueToday.items ?? []}
                  href="/invoices?status=issued"
                  itemHref={(it) => `/invoices/${it.id}`}
                  empty="Ninguna factura vence hoy."
                  renderActions={invoiceActions}
                />
                <SectionCard
                  title={`Vencidas · ${eur(data.invoicesOverdue.totalPending)}`}
                  icon={AlertTriangle}
                  count={data.invoicesOverdue.count}
                  items={data.invoicesOverdue.items ?? []}
                  href="/arrears"
                  itemHref={(it) => `/invoices/${it.id}`}
                  empty="Ninguna factura vencida."
                  renderActions={invoiceActions}
                />
                <SectionCard
                  title="Impagos: plazo vencido"
                  icon={Lock}
                  count={data.collectionsDeadlines.count}
                  items={data.collectionsDeadlines.items}
                  href="/collections"
                  itemHref={(it) => `/collections/${it.id}`}
                  empty="Ningún expediente con el plazo vencido."
                />
                <SectionCard
                  title="Fianzas por liquidar"
                  icon={PiggyBank}
                  count={data.depositsToSettle.count}
                  items={data.depositsToSettle.items}
                  href="/contracts"
                  itemHref={(it) => `/contracts/${it.id}`}
                  empty="Ninguna fianza pendiente de liquidar."
                />
                {data.depositsToRegister.count > 0 && (
                  <SectionCard
                    title="Fianzas de vivienda sin depositar"
                    icon={PiggyBank}
                    count={data.depositsToRegister.count}
                    items={data.depositsToRegister.items}
                    href="/contracts"
                    itemHref={(it) => `/contracts/${it.id}`}
                    empty="Todas las fianzas de vivienda están depositadas."
                  />
                )}
                <SectionCard
                  title="Fianzas a cobrar en el local"
                  icon={PiggyBank}
                  count={data.depositsToCollect.count}
                  items={data.depositsToCollect.items}
                  href="/contracts"
                  itemHref={(it) => (it.linkId ? `/contracts/${it.linkId}` : '/contracts')}
                  empty="Ninguna fianza pendiente de cobro."
                />
              </div>
            </TabsContent>

            <TabsContent value="operations" className="space-y-3">
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
              <div className="grid gap-3 sm:grid-cols-2">
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
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <SectionCard
                  title="Tareas para hoy"
                  icon={ClipboardList}
                  count={data.tasksDue.count}
                  items={data.tasksDue.items}
                  href="/tasks"
                  itemHref={(it) => `/tasks?task=${it.id}`}
                  empty="Sin tareas pendientes para hoy."
                  onComplete={canTasks ? completeTask : undefined}
                  completeLabel="Completar tarea"
                />
                <SectionCard
                  title="Firmas pendientes"
                  icon={FileSignature}
                  count={data.signaturesPending.count}
                  items={data.signaturesPending.items}
                  href="/contracts"
                  itemHref={(it) => `/contracts/${it.id}`}
                  empty="Ningún contrato pendiente de firma."
                  renderActions={
                    canSign
                      ? (it) => rowButton(`sign-${it.id}`, 'Reenviar', () => resendNow(it))
                      : undefined
                  }
                />
                <SectionCard
                  title="Contratos por vencer"
                  icon={CalendarClock}
                  count={data.contractsEndingSoon.count}
                  items={data.contractsEndingSoon.items}
                  href="/renewals"
                  itemHref={(it) => `/contracts/${it.id}`}
                  empty="Ningún contrato vence en 30 días."
                  renderActions={
                    canRenew
                      ? (it) => rowButton(`renew-${it.id}`, 'Prorrogar', () => renewNow(it))
                      : undefined
                  }
                />
                <SectionCard
                  title="Reservas que expiran"
                  icon={UserPlus}
                  count={data.reservationsExpiring.count}
                  items={data.reservationsExpiring.items}
                  href="/reservations"
                  itemHref={() => '/reservations?status=pending'}
                  empty="Ninguna reserva expira en 7 días."
                />
                {(data.unitsOutOfService?.count ?? 0) > 0 && (
                  <SectionCard
                    title="Trasteros parados"
                    icon={Wrench}
                    count={data.unitsOutOfService.count}
                    items={data.unitsOutOfService.items}
                    href="/units"
                    itemHref={(it) => `/units/${it.id}`}
                    empty=""
                  />
                )}
                {(data.lowStock?.count ?? 0) > 0 && (
                  <SectionCard
                    title="Productos por reponer"
                    icon={Package}
                    count={data.lowStock.count}
                    items={data.lowStock.items}
                    href="/products"
                    itemHref={() => '/products'}
                    empty=""
                  />
                )}
                {(data.facilityDocumentsExpiring?.count ?? 0) > 0 && (
                  <SectionCard
                    title="Documentos que caducan"
                    icon={FileWarning}
                    count={data.facilityDocumentsExpiring.count}
                    items={data.facilityDocumentsExpiring.items}
                    href="/facilities"
                    itemHref={(it) => `/facilities/${it.linkId}?tab=documents`}
                    empty=""
                  />
                )}
              </div>
            </TabsContent>

            <TabsContent value="sales" className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <StatTile
                  label="Mensajes sin leer"
                  value={String(data.unreadMessages)}
                  icon={MessageSquare}
                  href="/messages"
                  highlight={data.unreadMessages > 0}
                />
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <SectionCard
                  title="Leads sin contactar"
                  icon={Sparkles}
                  count={data.newLeads.count}
                  items={data.newLeads.items}
                  href="/leads"
                  itemHref={(it) => `/leads?lead=${it.id}`}
                  empty="Ningún lead nuevo sin contactar."
                />
                <SectionCard
                  title="Contactos sin atender"
                  icon={Timer}
                  count={data.unattendedLeads?.count ?? 0}
                  items={data.unattendedLeads?.items ?? []}
                  href="/leads/response"
                  itemHref={(it) => `/leads?lead=${it.id}`}
                  empty="Todos los contactos nuevos están atendidos a tiempo."
                />
                <SectionCard
                  title="Seguimientos de contactos"
                  icon={CalendarClock}
                  count={data.leadFollowupsDue?.count ?? 0}
                  items={data.leadFollowupsDue?.items ?? []}
                  href="/followups"
                  itemHref={(it) => (it.linkId ? `/leads?lead=${it.linkId}` : '/leads')}
                  empty="Sin seguimientos de contactos para hoy."
                  onComplete={canLeads ? completeLeadFollowup : undefined}
                  completeLabel="Marcar hecho"
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
                  title="Ofertas de retención sin responder"
                  icon={HeartHandshake}
                  count={data.retentionOffersPending.count}
                  items={data.retentionOffersPending.items}
                  href="/contracts"
                  itemHref={(it) => `/contracts/${it.id}`}
                  empty="Ninguna oferta de retención esperando respuesta."
                />
                <SectionCard
                  title="Renovaciones de marketing"
                  icon={Radio}
                  count={data.marketingRenewalsDue.count}
                  items={data.marketingRenewalsDue.items}
                  href="/marketing/channels"
                  itemHref={() => '/marketing/channels'}
                  empty="Ningún canal renueva en 7 días."
                />
              </div>
            </TabsContent>

            <TabsContent value="activity">
              <ActivityList items={summary.data?.activity ?? null} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

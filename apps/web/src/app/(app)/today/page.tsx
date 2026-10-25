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
import { useState } from 'react';
import { toast } from 'sonner';

import type {
  TodayActivityDto,
  TodayActivityKind,
  TodayItemDto,
  TodaySummaryDto,
} from '@storageos/shared';

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

/** Cifras del mes: lo cobrado frente a lo facturado, deuda, ocupación, altas y bajas. */
function KpiStrip({ summary }: { summary: TodaySummaryDto | undefined }) {
  if (!summary) return null;
  const k = summary.kpis;
  const pct = k.invoicedMonth > 0 ? Math.min(100, (k.collectedMonth / k.invoicedMonth) * 100) : 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="sm:col-span-2">
        <CardContent className="space-y-2 pt-6">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs text-muted-foreground">Cobrado este mes</p>
            <p className="text-xs text-muted-foreground">de {eur(k.invoicedMonth)} facturado</p>
          </div>
          <p className="text-2xl font-semibold tabular-nums">{eur(k.collectedMonth)}</p>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>
          {k.overduePending > 0 && (
            <Link
              href="/arrears"
              className="block text-xs font-medium text-red-600 hover:underline"
            >
              {eur(k.overduePending)} vencido sin cobrar →
            </Link>
          )}
        </CardContent>
      </Card>
      <Link href="/units">
        <Card className="h-full">
          <CardContent className="space-y-1 pt-6">
            <p className="text-xs text-muted-foreground">Ocupación</p>
            <p className="text-2xl font-semibold tabular-nums">{k.occupancyPct}%</p>
            <p className="text-xs text-muted-foreground">
              {k.freeUnits} libres de {k.totalUnits}
            </p>
          </CardContent>
        </Card>
      </Link>
      <Link href="/contracts">
        <Card className="h-full">
          <CardContent className="space-y-1 pt-6">
            <p className="text-xs text-muted-foreground">Este mes</p>
            <p className="text-2xl font-semibold tabular-nums">
              <span className="text-emerald-700 dark:text-emerald-400">+{k.moveInsMonth}</span>{' '}
              <span className="text-red-600">−{k.moveOutsMonth}</span>
            </p>
            <p className="text-xs text-muted-foreground">altas y bajas</p>
          </CardContent>
        </Card>
      </Link>
    </div>
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

export default function TodayPage() {
  const [facilityFilterId, setFacilityFilterId] = useFacilityFilterState();
  const facilityId = facilityFilterId ?? 'all';
  const setFacilityId = (v: string) => setFacilityFilterId(v === 'all' ? undefined : v);
  const facilities = useFacilities();
  const { data, isLoading } = useToday(facilityId === 'all' ? undefined : facilityId);
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
          data.newLeads.count +
          data.followupsDue.count +
          (data.leadFollowupsDue?.count ?? 0) +
          (data.unattendedLeads?.count ?? 0) +
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
          <KpiStrip summary={summary.data} />
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
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
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
                  itemHref={() => '/tasks'}
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
                  href="/customers"
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
                  itemHref={() => '/leads'}
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

'use client';

import {
  adminTodaySectionLabel,
  adminTodayUrgentCounts,
  FEATURE_LABELS,
  pluralEs,
  superAdminAuditLabel,
} from '@storageos/shared';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Clock,
  CreditCard,
  FileWarning,
  Globe,
  Hourglass,
  Keyboard,
  KeyRound,
  LifeBuoy,
  Loader2,
  Lock,
  Mail,
  Rocket,
  ShieldAlert,
  SkipForward,
  ThumbsDown,
  UserX,
  WifiOff,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { AddManualPaymentDialog } from '../tenants/[id]/saas-payments-card';

import { ApprovalsSection } from './approvals-section';
import { reportBatch, TodayBatchBar } from './today-batch-bar';
import { focusNextUrgent, ShortcutsHelp, useTodayShortcuts } from './today-keyboard';
import {
  ReappearedBadge,
  Row,
  RowShell,
  SimpleCard,
  SnoozeMenu,
  TenantRow,
  TodaySelectionProvider,
  useTodaySelectionState,
} from './today-rows';
import {
  FailedJobsCard,
  InactiveRow,
  LeadRow,
  PaymentFailureRow,
  ResponseTargets,
  TicketRow,
} from './today-sections';
import { TodayVisitCard } from './today-visit';

import type {
  AdminActivityItemDto,
  AdminAddonChargeDueDto,
  AdminAtRiskTenantDto,
  AdminBusinessGoalsDto,
  AdminTodayDoneDto,
  AdminTodayDto,
  AdminTodayKpisDto,
  AdminTodayMoneyAtRiskDto,
  AdminTodaySnoozeDto,
  SaasPaymentProviderValue,
  TenantFollowupDto,
} from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { FollowupControls } from '@/components/admin/followup-controls';
import { GoalBar } from '@/components/admin/goal-bar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAdminAuthStore } from '@/lib/admin/auth-store';
import {
  useAddonSuspension,
  useAdminToday,
  useChargeAddon,
  useExtendTrialsBatch,
  useRemindReceivable,
  useRemoveTodaySnooze,
  useTodayBatch,
  useTodaySnooze,
  useUpdateFollowup,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

const eur = (n: number, c = 'EUR') =>
  n.toLocaleString('es-ES', { style: 'currency', currency: c || 'EUR' });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('es-ES');
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });

const PROVIDERS: { value: SaasPaymentProviderValue; label: string }[] = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'bank_transfer', label: 'Transferencia' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'other', label: 'Otro' },
];

const MINE_KEY = 'storageos.admin.today.mine';

/** Con «Lo mío» solo queda lo que se puede asignar: tickets, leads y seguimientos. */
function onlyMine(data: AdminTodayDto, me: string | undefined): AdminTodayDto {
  const followup = (f: TenantFollowupDto) => f.assignedToId === me;
  return {
    ...data,
    openTickets: data.openTickets.filter((t) => t.assignedAdminId === me),
    followupsDue: data.followupsDue.filter(followup),
    followupsUpcoming: data.followupsUpcoming.filter(followup),
    addonCharges: [],
    manualRenewalsDue: [],
    trialsExpiring: [],
    pastDue: [],
    staleSuspendedAddons: [],
    failedWebhooks: [],
    failedJobs: 0,
    failedJobsList: [],
    aeatIssues: [],
    certificatesExpiring: [],
    holdedReview: [],
    devicesOffline: [],
    overdueCrons: [],
    pendingApprovals: [],
    expiringOverrides: [],
    // Los sin asignar son de todos; en «Lo mío», los que tengo yo sin atender.
    newLeads: [],
    assignedLeads: data.assignedLeads.filter((l) => l.assignedToId === me),
    leadFollowupsDue: data.leadFollowupsDue.filter((f) => f.assignedToId === me),
    paymentFailures: [],
    inactivePaying: [],
    domainsReady: [],
    incompleteInvoices: [],
    rgpdOverdue: [],
    npsNegative: [],
    activationStalled: [],
  };
}

const trialDaysLeft = (t: AdminAtRiskTenantDto) =>
  t.since ? Math.ceil((new Date(t.since).getTime() - Date.now()) / 86_400_000) : 99;

type TodayTab = 'business' | 'week' | 'ops' | 'activity';

export default function AdminTodayPage() {
  const today = useAdminToday();
  const me = useAdminAuthStore((s) => s.superAdmin?.id);
  const [mine, setMine] = useState(false);
  const [tab, setTab] = useState<TodayTab>('business');
  const [help, setHelp] = useState(false);
  const selection = useTodaySelectionState();
  const snooze = useTodaySnooze();
  const batch = useTodayBatch();

  useEffect(() => {
    try {
      setMine(localStorage.getItem(MINE_KEY) === '1');
    } catch {
      /* sin almacenamiento: empieza en «Todo» */
    }
  }, []);

  useTodayShortcuts({
    onHelp: () => setHelp(true),
    onSnooze: (target) =>
      snooze.mutate(
        { ...target, days: 7 },
        {
          onSuccess: () => toast.success(`Apartado 7 días: ${target.label}.`),
          onError: (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
        },
      ),
    onAssign: (target) =>
      batch.mutate(
        { action: 'assign', items: [{ kind: target.kind, ref: target.ref }] },
        {
          onSuccess: (result) => reportBatch('Asignado a ti', result),
          onError: (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
        },
      ),
  });

  function toggleMine(value: boolean) {
    setMine(value);
    try {
      localStorage.setItem(MINE_KEY, value ? '1' : '0');
    } catch {
      /* no se recuerda, sin más */
    }
  }

  if (today.isError) {
    return <AdminError onRetry={() => void today.refetch()} />;
  }
  if (today.isLoading || !today.data) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const data = mine ? onlyMine(today.data, me) : today.data;

  // Lo que tiene días por delante va a «Esta semana».
  const renewalsNow = data.manualRenewalsDue.filter((r) => r.daysLeft <= 1);
  const renewalsWeek = data.manualRenewalsDue.filter((r) => r.daysLeft > 1);
  const trialsNow = data.trialsExpiring.filter((t) => trialDaysLeft(t) <= 1);
  const trialsWeek = data.trialsExpiring.filter((t) => trialDaysLeft(t) > 1);
  const overridesNow = data.expiringOverrides.filter((o) => o.daysLeft <= 1);
  const overridesWeek = data.expiringOverrides.filter((o) => o.daysLeft > 1);
  const weekCount =
    renewalsWeek.length + trialsWeek.length + overridesWeek.length + data.followupsUpcoming.length;

  // Urgentes por pestaña: la misma cuenta que el servidor, así que cuadran con la
  // cabecera (con «Lo mío», sobre lo que queda y con mis leads sin atender).
  const urgent = adminTodayUrgentCounts(data, { mine });
  const opsCount =
    data.aeatIssues.length +
    data.certificatesExpiring.length +
    data.holdedReview.length +
    data.devicesOffline.length +
    data.overdueCrons.length +
    data.failedWebhooks.length +
    (data.failedJobs > 0 ? 1 : 0);
  const businessCount =
    data.pendingApprovals.length +
    data.addonCharges.length +
    data.pastDue.length +
    data.paymentFailures.length +
    renewalsNow.length +
    trialsNow.length +
    data.followupsDue.length +
    data.openTickets.length +
    overridesNow.length +
    data.staleSuspendedAddons.length +
    data.newLeads.length +
    data.assignedLeads.length +
    data.leadFollowupsDue.length +
    data.domainsReady.length +
    data.incompleteInvoices.length +
    data.rgpdOverdue.length +
    data.npsNegative.length +
    data.activationStalled.length +
    data.inactivePaying.length;

  /** «Siguiente»: el siguiente aviso urgente; si en esta pestaña no hay, salta a la otra. */
  function nextUrgent() {
    if (focusNextUrgent()) return;
    const other: TodayTab | null =
      tab !== 'business' && urgent.business > 0
        ? 'business'
        : tab !== 'ops' && urgent.ops > 0
          ? 'ops'
          : null;
    if (!other) {
      toast.info('No queda nada urgente.');
      return;
    }
    setTab(other);
    // Tras pintar la otra pestaña.
    window.setTimeout(() => focusNextUrgent(), 50);
  }

  const ovr = (o: (typeof data.expiringOverrides)[number], isUrgent: boolean) => (
    <TenantRow
      key={`${o.tenantId}-${o.feature}`}
      id={o.tenantId}
      name={`${o.tenantName} · ${o.trialAddonName ?? FEATURE_LABELS[o.feature] ?? o.feature}`}
      detail={`${o.source === 'trial' ? 'Prueba gratis' : 'Cortesía'} · ${
        o.daysLeft <= 0 ? 'vence hoy' : o.daysLeft === 1 ? 'vence mañana' : `quedan ${o.daysLeft} d`
      }`}
      urgent={isUrgent}
      snooze={{ kind: 'override', ref: `${o.tenantId}-${o.feature}`, label: o.tenantName }}
    />
  );
  const renewal = (r: (typeof data.manualRenewalsDue)[number], isUrgent: boolean) => (
    <TenantRow
      key={r.tenantId}
      id={r.tenantId}
      name={r.tenantName}
      detail={[
        r.daysLeft < 0
          ? `Vencida hace ${Math.abs(r.daysLeft)} d`
          : r.daysLeft === 0
            ? 'Vence hoy'
            : `Vence en ${r.daysLeft} d`,
        r.monthly ? `${eur(r.monthly)}/mes sin IVA` : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      urgent={isUrgent}
      snooze={{ kind: 'renewal', ref: r.tenantId, label: r.tenantName }}
      notice={r.reappearedReason}
    />
  );

  return (
    <TodaySelectionProvider value={selection}>
      <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Hoy</h1>
            <p className="text-sm text-muted-foreground">
              {new Date(data.date).toLocaleDateString('es-ES', { dateStyle: 'full' })}
              {urgent.total > 0
                ? ` · ${pluralEs(urgent.total, 'acción urgente', 'acciones urgentes')}`
                : ''}
            </p>
            {today.data.workload.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {today.data.workload
                  .map((w) => `${w.name}: ${w.tickets} tickets, ${w.followups} seguimientos`)
                  .join(' · ')}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={nextUrgent}
              disabled={urgent.total === 0}
              title="Ir al siguiente aviso urgente"
            >
              <SkipForward className="size-4" />
              Siguiente
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label="Atajos de teclado"
              aria-keyshortcuts="?"
              title="Atajos de teclado (?)"
              onClick={() => setHelp(true)}
            >
              <Keyboard className="size-4" />
            </Button>
            <div className="flex gap-1" role="group" aria-label="Qué ver">
              <Button
                size="sm"
                variant={mine ? 'outline' : 'default'}
                aria-pressed={!mine}
                onClick={() => toggleMine(false)}
              >
                Todo
              </Button>
              <Button
                size="sm"
                variant={mine ? 'default' : 'outline'}
                aria-pressed={mine}
                onClick={() => toggleMine(true)}
              >
                Lo mío
              </Button>
            </div>
          </div>
        </div>

        {today.data.failedSections.length > 0 && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            <span>
              No se pudo cargar: {today.data.failedSections.map(adminTodaySectionLabel).join(', ')}.
              El resto de la bandeja está al día.
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={today.isFetching}
              onClick={() => void today.refetch()}
            >
              Reintentar
            </Button>
          </div>
        )}

        <TodayVisitCard />
        <TodayKpis kpis={today.data.kpis} moneyAtRisk={today.data.moneyAtRisk} />
        {today.data.businessGoals && <TodayGoals goals={today.data.businessGoals} />}

        <Tabs value={tab} onValueChange={(v) => setTab(v as TodayTab)}>
          <TabsList>
            <TabsTrigger value="business">
              <TabLabel label="Negocio" total={businessCount} urgent={urgent.business} />
            </TabsTrigger>
            <TabsTrigger value="week">
              Esta semana{weekCount > 0 ? ` (${weekCount})` : ''}
            </TabsTrigger>
            <TabsTrigger value="ops">
              <TabLabel label="Operación" total={opsCount} urgent={urgent.ops} />
            </TabsTrigger>
            <TabsTrigger value="activity">Actividad</TabsTrigger>
          </TabsList>

          <TabsContent value="business" className="mt-4 space-y-6">
            <ApprovalsSection items={data.pendingApprovals} />

            {data.paymentFailures.length > 0 && (
              <SimpleCard
                title={`Cobros de la suscripción rechazados (${data.paymentFailures.length})`}
                icon={<XCircle className="size-4 text-red-500" />}
                action={{ href: '/admin/receivables', label: 'Cobros pendientes →' }}
                description="Cargos de Stripe, tarjeta de Redsys y adeudos SEPA rechazados en las últimas 48 horas."
              >
                {data.paymentFailures.map((f) => (
                  <PaymentFailureRow key={f.tenantId} failure={f} />
                ))}
              </SimpleCard>
            )}

            {data.addonCharges.length > 0 && (
              <SimpleCard
                title={`Cobros de add-ons pendientes (${data.addonCharges.length})`}
                icon={<CreditCard className="size-4 text-amber-500" />}
                description="Extras que se cobran a mano. Registrar el cobro no toca el periodo del plan y programa el siguiente un mes después de la fecha que tocaba."
              >
                {data.addonCharges.map((c) => (
                  <AddonChargeRow key={c.tenantAddonId} charge={c} />
                ))}
              </SimpleCard>
            )}

            {data.pastDue.length > 0 && (
              <SimpleCard
                title={`Pagos pendientes (${data.pastDue.length})${
                  data.pastDue.some((t) => t.owedAmount)
                    ? ` · ${eur(data.pastDue.reduce((sum, t) => sum + (t.owedAmount ?? 0), 0))}`
                    : ''
                }`}
                icon={<AlertTriangle className="size-4 text-red-500" />}
              >
                {data.pastDue.map((t) => (
                  <PastDueRow key={t.id} tenant={t} />
                ))}
              </SimpleCard>
            )}

            {renewalsNow.length > 0 && (
              <SimpleCard
                title={`Renovaciones manuales (${renewalsNow.length})`}
                icon={<CalendarClock className="size-4 text-amber-500" />}
              >
                {renewalsNow.map((r) => renewal(r, true))}
              </SimpleCard>
            )}

            {trialsNow.length > 0 && (
              <SimpleCard
                title={`Pruebas que terminan ya (${trialsNow.length})`}
                icon={<CalendarClock className="size-4 text-amber-500" />}
              >
                {trialsNow.map((t) => (
                  <TrialRow key={t.id} tenant={t} urgent />
                ))}
              </SimpleCard>
            )}

            {data.followupsDue.length > 0 && (
              <SimpleCard
                title={`Seguimientos vencidos (${data.followupsDue.length})`}
                icon={<CalendarClock className="size-4 text-amber-500" />}
              >
                {data.followupsDue.map((f) => (
                  <FollowupRow key={f.id} followup={f} urgent />
                ))}
              </SimpleCard>
            )}

            {data.openTickets.length > 0 && (
              <SimpleCard
                title={`Tickets sin responder (${data.openTickets.length})`}
                icon={<LifeBuoy className="size-4 text-red-500" />}
                description={<ResponseTargets targets={today.data.responseTargets} />}
              >
                {data.openTickets.map((t) => (
                  <TicketRow key={t.id} ticket={t} />
                ))}
              </SimpleCard>
            )}

            {data.newLeads.length > 0 && (
              <SimpleCard
                title={`Leads sin asignar (${data.newLeads.length})`}
                icon={<Mail className="size-4 text-amber-500" />}
                action={{ href: '/admin/leads', label: 'Ver leads →' }}
              >
                {data.newLeads.map((c) => (
                  <LeadRow key={c.id} lead={c} urgent />
                ))}
              </SimpleCard>
            )}

            {data.assignedLeads.length > 0 && (
              <SimpleCard
                title={`Leads asignados sin atender (${data.assignedLeads.length})`}
                icon={<Mail className="size-4 text-muted-foreground" />}
                action={{ href: '/admin/leads', label: 'Ver leads →' }}
                description="Tienen a alguien que los lleva, pero nadie les ha respondido en más de 24 horas."
              >
                {data.assignedLeads.map((c) => (
                  <LeadRow key={c.id} lead={c} urgent={mine} />
                ))}
              </SimpleCard>
            )}

            {data.leadFollowupsDue.length > 0 && (
              <SimpleCard
                title={`Seguimientos de leads (${data.leadFollowupsDue.length})`}
                icon={<CalendarClock className="size-4 text-amber-500" />}
                action={{ href: '/admin/followups', label: 'Ver seguimientos →' }}
              >
                {data.leadFollowupsDue.map((f) => (
                  <Row
                    key={f.id}
                    urgent
                    title={
                      <Link
                        href={`/admin/leads?lead=${f.leadId}`}
                        data-row-link=""
                        className="hover:underline"
                      >
                        <span className="font-medium">{f.leadName}</span> · {f.title}
                      </Link>
                    }
                    detail={`${f.dueDate}${f.assignedToName ? ` · ${f.assignedToName}` : ''}`}
                    snooze={{
                      kind: 'lead_followup',
                      ref: f.id,
                      label: `${f.leadName}: ${f.title}`,
                    }}
                  />
                ))}
              </SimpleCard>
            )}

            {data.domainsReady.length > 0 && (
              <SimpleCard
                title={`Dominios propios por activar (${data.domainsReady.length})`}
                icon={<Globe className="size-4 text-amber-500" />}
                action={{ href: '/admin/custom-domains', label: 'Activar →' }}
              >
                {data.domainsReady.map((d) => (
                  <TenantRow
                    key={d.tenantId}
                    id={d.tenantId}
                    name={d.tenantName}
                    detail={d.domain}
                    urgent
                    snooze={{ kind: 'domain', ref: d.tenantId, label: d.tenantName }}
                  />
                ))}
              </SimpleCard>
            )}

            {data.rgpdOverdue.length > 0 && (
              <SimpleCard
                title={`Solicitudes RGPD fuera de plazo (${data.rgpdOverdue.length})`}
                icon={<ShieldAlert className="size-4 text-red-500" />}
              >
                {data.rgpdOverdue.map((t) => (
                  <TenantRow
                    key={t.tenantId}
                    id={t.tenantId}
                    name={t.tenantName}
                    detail={`${t.count} sin atender`}
                    urgent
                    snooze={{ kind: 'rgpd', ref: t.tenantId, label: t.tenantName }}
                    notice={t.reappearedReason}
                  />
                ))}
              </SimpleCard>
            )}

            {data.inactivePaying.length > 0 && (
              <SimpleCard
                title={`Clientes que han dejado de entrar (${data.inactivePaying.length})`}
                icon={<UserX className="size-4 text-amber-500" />}
                description="Pagan y nadie de su equipo entra desde hace 14 días o más: riesgo de baja."
              >
                {data.inactivePaying.map((t) => (
                  <InactiveRow key={t.tenantId} tenant={t} />
                ))}
              </SimpleCard>
            )}

            {data.incompleteInvoices.length > 0 && (
              <SimpleCard
                title={`Facturas de suscripción sin NIF o domicilio (${data.incompleteInvoices.length})`}
                icon={<FileWarning className="size-4 text-amber-500" />}
              >
                {data.incompleteInvoices.map((t) => (
                  <TenantRow
                    key={t.tenantId}
                    id={t.tenantId}
                    name={t.tenantName}
                    detail={`${t.count} por rectificar`}
                    snooze={{ kind: 'invoice_data', ref: t.tenantId, label: t.tenantName }}
                    notice={t.reappearedReason}
                  />
                ))}
              </SimpleCard>
            )}

            {data.npsNegative.length > 0 && (
              <SimpleCard
                title={`Respuestas NPS bajas (${data.npsNegative.length})`}
                icon={<ThumbsDown className="size-4 text-amber-500" />}
              >
                {data.npsNegative.map((n) => (
                  <TenantRow
                    key={n.id}
                    id={n.tenantId}
                    name={n.tenantName}
                    detail={`Nota ${n.score}${n.comment ? ` · ${n.comment.slice(0, 80)}` : ''}`}
                    snooze={{ kind: 'nps', ref: n.id, label: n.tenantName }}
                  />
                ))}
              </SimpleCard>
            )}

            {data.activationStalled.length > 0 && (
              <SimpleCard
                title={`Pruebas sin arrancar (${data.activationStalled.length})`}
                icon={<Rocket className="size-4 text-amber-500" />}
              >
                {data.activationStalled.map((a) => (
                  <TenantRow
                    key={a.tenantId}
                    id={a.tenantId}
                    name={a.tenantName}
                    detail={`${a.daysSinceSignup} d · ${MISSING[a.missing]}`}
                    snooze={{ kind: 'activation', ref: a.tenantId, label: a.tenantName }}
                    actions={
                      a.ownerEmail && (
                        <Button asChild size="sm" variant="outline">
                          <a href={`mailto:${a.ownerEmail}`}>Escribir</a>
                        </Button>
                      )
                    }
                  />
                ))}
              </SimpleCard>
            )}

            {overridesNow.length > 0 && (
              <SimpleCard
                title={`Pruebas gratis y cortesías que vencen (${overridesNow.length})`}
                icon={<Hourglass className="size-4 text-amber-500" />}
              >
                {overridesNow.map((o) => ovr(o, true))}
              </SimpleCard>
            )}

            {data.staleSuspendedAddons.length > 0 && (
              <SimpleCard
                title={`Add-ons suspendidos hace tiempo (${data.staleSuspendedAddons.length})`}
                icon={<Lock className="size-4 text-muted-foreground" />}
              >
                {data.staleSuspendedAddons.map((s) => (
                  <TenantRow
                    key={s.tenantAddonId}
                    id={s.tenantId}
                    name={`${s.tenantName} · ${s.addonName}`}
                    detail={`Suspendido hace ${s.daysSuspended} d`}
                    snooze={{ kind: 'stale_addon', ref: s.tenantAddonId, label: s.tenantName }}
                  />
                ))}
              </SimpleCard>
            )}
            {businessCount === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {mine ? 'No tienes nada asignado para hoy.' : 'Nada de negocio pendiente. 🎉'}
              </p>
            )}
            {!mine && <SnoozedList items={today.data.snoozes} />}
          </TabsContent>

          <TabsContent value="week" className="mt-4 space-y-6">
            {renewalsWeek.length > 0 && (
              <SimpleCard
                title={`Renovaciones manuales (${renewalsWeek.length})`}
                icon={<CalendarClock className="size-4 text-amber-500" />}
              >
                {renewalsWeek.map((r) => renewal(r, false))}
              </SimpleCard>
            )}
            {trialsWeek.length > 0 && (
              <SimpleCard
                title={`Pruebas que terminan (${trialsWeek.length})`}
                icon={<CalendarClock className="size-4 text-amber-500" />}
              >
                {trialsWeek.map((t) => (
                  <TrialRow key={t.id} tenant={t} />
                ))}
              </SimpleCard>
            )}
            {data.followupsUpcoming.length > 0 && (
              <SimpleCard
                title={`Seguimientos (${data.followupsUpcoming.length})`}
                icon={<CalendarClock className="size-4 text-muted-foreground" />}
              >
                {data.followupsUpcoming.map((f) => (
                  <FollowupRow key={f.id} followup={f} />
                ))}
              </SimpleCard>
            )}
            {overridesWeek.length > 0 && (
              <SimpleCard
                title={`Pruebas gratis y cortesías (${overridesWeek.length})`}
                icon={<Hourglass className="size-4 text-amber-500" />}
              >
                {overridesWeek.map((o) => ovr(o, false))}
              </SimpleCard>
            )}
            {weekCount === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nada previsto para esta semana.
              </p>
            )}
          </TabsContent>

          <TabsContent value="ops" className="mt-4 space-y-6">
            {data.aeatIssues.length > 0 && (
              <SimpleCard
                title={`Facturas con problemas en Veri*Factu (${data.aeatIssues.length})`}
                icon={<FileWarning className="size-4 text-red-500" />}
                action={{ href: '/admin/billing-health', label: 'Ver detalle →' }}
              >
                {data.aeatIssues.map((t) => (
                  <TenantRow
                    key={t.tenantId}
                    id={t.tenantId}
                    name={t.tenantName}
                    detail={pluralEs(
                      t.count,
                      'factura rechazada, con error o sin respuesta',
                      'facturas rechazadas, con error o sin respuesta',
                    )}
                    urgent
                    snooze={{ kind: 'aeat', ref: t.tenantId, label: t.tenantName }}
                    notice={t.reappearedReason}
                  />
                ))}
              </SimpleCard>
            )}

            {data.certificatesExpiring.length > 0 && (
              <SimpleCard
                title={`Certificados de la AEAT que caducan (${data.certificatesExpiring.length})`}
                icon={<KeyRound className="size-4 text-amber-500" />}
              >
                {data.certificatesExpiring.map((c) => (
                  <TenantRow
                    key={c.id}
                    id={c.tenantId}
                    name={
                      c.ownerName ? `${c.tenantName} · propietario ${c.ownerName}` : c.tenantName
                    }
                    detail={
                      c.daysLeft <= 0
                        ? `Caducado el ${fmtDate(c.validTo)}`
                        : `Caduca en ${c.daysLeft} d (${fmtDate(c.validTo)})`
                    }
                    urgent={c.daysLeft <= 15}
                    snooze={{ kind: 'certificate', ref: c.id, label: c.tenantName }}
                    notice={c.reappearedReason}
                  />
                ))}
              </SimpleCard>
            )}

            {data.holdedReview.length > 0 && (
              <SimpleCard
                title={`Holded: envíos para revisar (${data.holdedReview.length})`}
                icon={<FileWarning className="size-4 text-amber-500" />}
                action={{ href: '/admin/billing-health', label: 'Ver detalle →' }}
              >
                {data.holdedReview.map((t) => (
                  <TenantRow
                    key={t.tenantId}
                    id={t.tenantId}
                    name={t.tenantName}
                    detail={`${t.count} para revisar`}
                    urgent
                    snooze={{ kind: 'holded', ref: t.tenantId, label: t.tenantName }}
                    notice={t.reappearedReason}
                  />
                ))}
              </SimpleCard>
            )}

            {data.devicesOffline.length > 0 && (
              <SimpleCard
                title={`Dispositivos de acceso sin conexión (${data.devicesOffline.length})`}
                icon={<WifiOff className="size-4 text-red-500" />}
              >
                {data.devicesOffline.map((t) => (
                  <TenantRow
                    key={t.tenantId}
                    id={t.tenantId}
                    name={t.tenantName}
                    detail={`${t.count} sin señal desde hace más de 1 h`}
                    urgent
                    snooze={{ kind: 'device', ref: t.tenantId, label: t.tenantName }}
                    notice={t.reappearedReason}
                  />
                ))}
              </SimpleCard>
            )}

            {data.overdueCrons.length > 0 && (
              <SimpleCard
                title={`Tareas programadas sin ejecutarse (${data.overdueCrons.length})`}
                icon={<Clock className="size-4 text-red-500" />}
                action={{ href: '/admin/queues', label: 'Ver tareas →' }}
              >
                {data.overdueCrons.map((c) => (
                  <Row
                    key={c.name}
                    urgent
                    title={<span className="font-mono text-xs">{c.name}</span>}
                    detail={`${c.process} · tocaba ${c.nextRunAt ? fmtDateTime(c.nextRunAt) : '—'}`}
                    snooze={{ kind: 'cron', ref: c.name, label: c.name }}
                  />
                ))}
              </SimpleCard>
            )}

            {data.failedWebhooks.length > 0 && (
              <SimpleCard
                title={`Webhooks que siguen fallando (${data.failedWebhooks.length})`}
                icon={<AlertTriangle className="size-4 text-amber-500" />}
              >
                {data.failedWebhooks.map((w) => (
                  <Row
                    key={w.tenantId}
                    urgent
                    title={
                      <>
                        <Link
                          href={`/admin/tenants/${w.tenantId}`}
                          data-row-link=""
                          className="font-medium hover:underline"
                        >
                          {w.tenantName}
                        </Link>
                        {w.lastError && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {w.lastError}
                          </span>
                        )}
                      </>
                    }
                    detail={`${pluralEs(w.failedCount, 'fallo', 'fallos')} · ${fmtDate(w.lastFailedAt)}`}
                    snooze={{ kind: 'webhook', ref: w.tenantId, label: w.tenantName }}
                    notice={w.reappearedReason}
                  />
                ))}
              </SimpleCard>
            )}

            {data.failedJobs > 0 && (
              <FailedJobsCard total={data.failedJobs} jobs={data.failedJobsList} />
            )}
            {opsCount === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {mine ? 'Aquí no hay nada asignable.' : 'Todo funciona. 👌'}
              </p>
            )}
          </TabsContent>

          <TabsContent value="activity" className="mt-4 space-y-6">
            <DoneToday done={today.data.done} />
            <ActivityFeed items={today.data.activity} />
          </TabsContent>
        </Tabs>

        <TodayBatchBar selected={[...selection.selected.values()]} onClear={selection.clear} />
        <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
      </div>
    </TodaySelectionProvider>
  );
}

const MISSING: Record<'facility' | 'units' | 'contract', string> = {
  facility: 'sin local',
  units: 'sin trasteros',
  contract: 'sin contratos',
};

function SnoozedList({ items }: { items: AdminTodaySnoozeDto[] }) {
  const remove = useRemoveTodaySnooze();
  if (items.length === 0) return null;
  return (
    <details className="text-sm text-muted-foreground">
      <summary className="cursor-pointer">
        {items.length === 1 ? '1 aviso apartado' : `${items.length} avisos apartados`}
      </summary>
      <ul className="mt-2 space-y-1">
        {items.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
            <span className="min-w-0 truncate">
              {s.label ?? s.ref} · hasta {fmtDate(s.until)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate(s.id)}
            >
              Recuperar
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PastDueRow({ tenant }: { tenant: AdminAtRiskTenantDto }) {
  const remind = useRemindReceivable();
  const canAct = useIsSuperadmin();
  const [paying, setPaying] = useState(false);
  const periods = tenant.owedPeriods ?? 0;
  const parts = [
    tenant.owedAmount ? eur(tenant.owedAmount) : tenant.detail,
    periods > 1 ? `${periods} cuotas` : null,
    tenant.since ? `desde ${fmtDate(tenant.since)}` : null,
  ].filter(Boolean);
  return (
    <>
      <TenantRow
        id={tenant.id}
        name={tenant.name}
        detail={parts.join(' · ')}
        urgent
        snooze={{ kind: 'past_due', ref: tenant.id, label: tenant.name }}
        notice={tenant.reappearedReason}
        actions={
          canAct && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={remind.isPending}
                onClick={() =>
                  remind.mutate(tenant.id, {
                    onSuccess: () => toast.success('Recordatorio enviado.'),
                    onError: (err) =>
                      toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                  })
                }
              >
                Recordar
              </Button>
              <Button size="sm" onClick={() => setPaying(true)}>
                Registrar pago
              </Button>
            </>
          )
        }
      />
      {paying && (
        <AddManualPaymentDialog
          tenantId={tenant.id}
          open={paying}
          onClose={() => setPaying(false)}
          {...(tenant.owedAmount ? { defaultAmount: tenant.owedAmount } : {})}
        />
      )}
    </>
  );
}

function TrialRow({ tenant, urgent = false }: { tenant: AdminAtRiskTenantDto; urgent?: boolean }) {
  const extend = useExtendTrialsBatch();
  const canAct = useIsSuperadmin();
  const u = tenant.usage;
  const usage = u
    ? `${u.facilities} locales, ${u.units} trasteros, ${u.contracts} contratos · ${
        u.lastLoginAt ? `entró el ${fmtDate(u.lastLoginAt)}` : 'nunca entró'
      }`
    : '';
  return (
    <TenantRow
      id={tenant.id}
      name={tenant.name}
      detail={[
        tenant.since ? `Termina ${fmtDate(tenant.since)}` : 'Prueba',
        tenant.monthly ? `${eur(tenant.monthly)}/mes sin IVA` : null,
        usage,
      ]
        .filter(Boolean)
        .join(' · ')}
      urgent={urgent}
      snooze={{ kind: 'trial', ref: tenant.id, label: tenant.name }}
      actions={
        canAct && (
          <Button
            size="sm"
            variant="outline"
            disabled={extend.isPending}
            onClick={() =>
              extend.mutate(
                { tenantIds: [tenant.id], days: 7 },
                {
                  onSuccess: () => toast.success('Prueba ampliada 7 días.'),
                  onError: (err) =>
                    toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                },
              )
            }
          >
            +7 días
          </Button>
        )
      }
    />
  );
}

function FollowupRow({
  followup: f,
  urgent = false,
}: {
  followup: TenantFollowupDto;
  urgent?: boolean;
}) {
  const update = useUpdateFollowup();
  return (
    <TenantRow
      id={f.tenantId}
      name={f.tenantName ?? '—'}
      detail={`${f.title} · ${fmtDate(f.dueDate)}`}
      urgent={urgent}
      actions={
        <>
          <FollowupControls f={f} />
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Marcar hecho"
            title="Hecho"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { followupId: f.id, status: 'done' },
                { onSuccess: () => toast.success('Seguimiento hecho.') },
              )
            }
          >
            <Check className="size-4" />
          </Button>
        </>
      }
    />
  );
}

function DoneToday({ done }: { done: AdminTodayDoneDto }) {
  if (done.ticketsAnswered + done.followupsDone + done.actions.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Hecho hoy</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          {pluralEs(done.ticketsAnswered, 'ticket respondido', 'tickets respondidos')} ·{' '}
          {pluralEs(done.followupsDone, 'seguimiento hecho', 'seguimientos hechos')} ·{' '}
          {pluralEs(done.actions.length, 'acción', 'acciones')}
        </p>
        <ul className="space-y-1">
          {done.actions.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{superAdminAuditLabel(a.action)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {a.adminName ?? '—'} · {fmtDateTime(a.at)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function AddonChargeRow({ charge }: { charge: AdminAddonChargeDueDto }) {
  const chargeAddon = useChargeAddon();
  const suspend = useAddonSuspension(charge.tenantId, 'suspend');
  const [provider, setProvider] = useState<SaasPaymentProviderValue>('cash');
  const canCharge = useIsSuperadmin();

  async function onCharge() {
    try {
      await chargeAddon.mutateAsync({ tenantAddonId: charge.tenantAddonId, provider });
      toast.success('Cobro registrado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar el cobro.');
    }
  }
  async function onSuspend() {
    try {
      await suspend.mutateAsync(charge.tenantAddonId);
      toast.success('Add-on suspendido por impago.');
    } catch {
      toast.error('No se pudo suspender.');
    }
  }

  return (
    <RowShell
      urgent
      snooze={{ kind: 'addon_charge', ref: charge.tenantAddonId, label: charge.tenantName }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/admin/tenants/${charge.tenantId}`}
            data-row-link=""
            className="font-medium hover:underline"
          >
            {charge.tenantName}
          </Link>
          <span className="text-muted-foreground"> · {charge.addonName}</span>
          {charge.overdueDays > 0 && (
            <span className="ml-1 text-xs text-red-500">(+{charge.overdueDays} d)</span>
          )}
          <ReappearedBadge reason={charge.reappearedReason} />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-semibold tabular-nums">{eur(charge.amount, charge.currency)}</span>
          <SnoozeMenu kind="addon_charge" refId={charge.tenantAddonId} label={charge.tenantName} />
          {canCharge && (
            <>
              <Select
                value={provider}
                onValueChange={(v) => setProvider(v as SaasPaymentProviderValue)}
              >
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={onCharge} disabled={chargeAddon.isPending}>
                Registrar cobro
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-amber-600 hover:text-amber-700"
                onClick={onSuspend}
                disabled={suspend.isPending}
              >
                Suspender
              </Button>
            </>
          )}
        </div>
      </div>
    </RowShell>
  );
}

/** Pestaña con sus avisos y, aparte, cuántos son urgentes. */
function TabLabel({ label, total, urgent }: { label: string; total: number; urgent: number }) {
  const hint =
    total === 0
      ? 'Nada pendiente'
      : `${pluralEs(total, 'aviso', 'avisos')}, ${pluralEs(urgent, 'urgente', 'urgentes')}`;
  return (
    <span className="flex items-center gap-1.5" title={hint}>
      {label}
      {total > 0 && <span className="text-muted-foreground">({total})</span>}
      {urgent > 0 && (
        <span
          className="rounded-full bg-red-600 px-1.5 text-[10px] font-semibold leading-4 text-white"
          aria-label={pluralEs(urgent, 'urgente', 'urgentes')}
        >
          {urgent}
        </span>
      )}
    </span>
  );
}

/** Cifras de arriba de «Hoy». */
/** Progreso de los objetivos del negocio (si hay alguno puesto). */
function TodayGoals({ goals }: { goals: AdminBusinessGoalsDto }) {
  const fmtEur = (n: number) =>
    n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">Objetivos</CardTitle>
        <Link href="/admin/metrics" className="text-xs text-muted-foreground hover:underline">
          Ver en Métricas
        </Link>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        {goals.progress.mrr && (
          <GoalBar label="MRR" progress={goals.progress.mrr} format={fmtEur} />
        )}
        {goals.progress.signups && (
          <GoalBar
            label="Altas este mes"
            progress={goals.progress.signups}
            format={(n) => String(Math.round(n))}
          />
        )}
        {goals.progress.trialConversion && (
          <GoalBar
            label="Conversión de pruebas"
            progress={goals.progress.trialConversion}
            format={(n) => `${Math.round(n)} %`}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** «+12 %» frente al periodo anterior; sin base con la que comparar, nada. */
function delta(current: number, previous: number | null): string | null {
  if (previous === null || previous <= 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  return `${pct > 0 ? '+' : ''}${pct} %`;
}

/** «Deuda 120 € · Pruebas 79 €…»: de dónde sale el dinero en juego. */
function moneyBreakdown(m: AdminTodayMoneyAtRiskDto): string {
  return [
    m.pastDue > 0 ? `Deuda vencida ${eur(m.pastDue)}` : null,
    m.trialsEnding > 0 ? `Pruebas que terminan ${eur(m.trialsEnding)}/mes sin IVA` : null,
    m.addonCharges > 0 ? `Extras por cobrar ${eur(m.addonCharges)}` : null,
    m.inactive > 0 ? `Clientes que no entran ${eur(m.inactive)}/mes sin IVA` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function TodayKpis({
  kpis,
  moneyAtRisk,
}: {
  kpis: AdminTodayKpisDto;
  moneyAtRisk: AdminTodayMoneyAtRiskDto;
}) {
  const breakdown = moneyBreakdown(moneyAtRisk);
  const items: {
    label: string;
    value: string;
    href: string;
    warn?: boolean;
    hint?: string;
    change?: { value: string | null; against: string };
  }[] = [
    {
      label: '€ en riesgo hoy',
      value: eur(moneyAtRisk.total),
      href: '/admin/receivables',
      warn: moneyAtRisk.total > 0,
      hint: breakdown || 'Nada en juego hoy',
    },
    {
      label: 'MRR (activos)',
      value: eur(kpis.mrr),
      href: '/admin/metrics',
      change: { value: delta(kpis.mrr, kpis.mrrPrevMonth), against: 'mes pasado' },
    },
    {
      label: 'Cobrado 7 días',
      value: eur(kpis.collected7d),
      href: '/admin/billing-calendar',
      change: { value: delta(kpis.collected7d, kpis.collectedPrev7d), against: '7 días antes' },
    },
    {
      label: 'Pendiente',
      value: eur(kpis.pending),
      href: '/admin/receivables',
      warn: kpis.pending > 0,
    },
    { label: 'En prueba', value: String(kpis.trials), href: '/admin/trials' },
    {
      label: 'Suspendidos',
      value: String(kpis.suspended),
      href: '/admin/tenants',
      warn: kpis.suspended > 0,
    },
    {
      label: 'Altas del mes',
      value: String(kpis.newThisMonth),
      href: '/admin/tenants',
      change: {
        value: delta(kpis.newThisMonth, kpis.newPrevMonthToDate),
        against: 'mismo punto del mes pasado',
      },
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
      {items.map((i) => (
        <Link
          key={i.label}
          href={i.href}
          title={i.hint}
          className="rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40"
        >
          <p className="text-xs text-muted-foreground">{i.label}</p>
          <p className={`text-lg font-semibold ${i.warn ? 'text-destructive' : ''}`}>{i.value}</p>
          {i.hint && i.hint !== 'Nada en juego hoy' && (
            <p className="text-xs text-muted-foreground">{i.hint}</p>
          )}
          {i.change?.value && (
            <p className="text-xs text-muted-foreground" title={`Frente a ${i.change.against}`}>
              {i.change.value} · {i.change.against}
            </p>
          )}
        </Link>
      ))}
    </div>
  );
}

const ACTIVITY: Record<AdminActivityItemDto['kind'], { label: string; className: string }> = {
  signup: {
    label: 'Alta',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  churn: { label: 'Baja', className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' },
  plan_changed: {
    label: 'Plan',
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  },
  addon_added: {
    label: 'Extra',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  addon_removed: {
    label: 'Extra',
    className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
  addon_trial: {
    label: 'Prueba',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  first_contract: {
    label: 'Uso',
    className: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  },
  payment: { label: 'Cobro', className: 'bg-muted text-foreground' },
  interest: {
    label: 'Interés',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
};

/** Lo que ha pasado con los tenants en las últimas 48 horas. */
function ActivityFeed({ items }: { items: AdminActivityItemDto[] }) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Nada nuevo en las últimas 48 horas.
      </p>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Últimas 48 horas</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {items.map((i, n) => (
            <li
              key={`${i.kind}-${i.tenantId}-${i.at}-${n}`}
              className="flex items-center gap-3 px-4 py-2 text-sm"
            >
              <span
                className={`w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-xs ${ACTIVITY[i.kind].className}`}
              >
                {ACTIVITY[i.kind].label}
              </span>
              <div className="min-w-0 flex-1">
                <Link href={`/admin/tenants/${i.tenantId}`} className="font-medium hover:underline">
                  {i.tenantName}
                </Link>{' '}
                <span className="text-muted-foreground">{i.text}</span>
              </div>
              {i.amount !== null && <span className="shrink-0 tabular-nums">{eur(i.amount)}</span>}
              <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                {fmtDateTime(i.at)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

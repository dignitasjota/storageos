'use client';

import { FEATURE_LABELS } from '@storageos/shared';
import {
  Hourglass,
  AlertTriangle,
  CalendarClock,
  Clock,
  CreditCard,
  FileWarning,
  KeyRound,
  LifeBuoy,
  Loader2,
  Lock,
  WifiOff,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { ApprovalsSection } from './approvals-section';

import type {
  AdminActivityItemDto,
  AdminAddonChargeDueDto,
  AdminBusinessGoalsDto,
  AdminTodayKpisDto,
  SaasPaymentProviderValue,
} from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
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
import { useAddonSuspension, useAdminToday, useChargeAddon } from '@/lib/admin/hooks';
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

export default function AdminTodayPage() {
  const today = useAdminToday();
  const data = today.data;

  if (today.isError) {
    return <AdminError onRetry={() => void today.refetch()} />;
  }
  if (today.isLoading) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const nothing =
    data &&
    data.addonCharges.length === 0 &&
    data.manualRenewalsDue.length === 0 &&
    data.pastDue.length === 0 &&
    data.trialsExpiring.length === 0 &&
    data.followupsDue.length === 0 &&
    data.staleSuspendedAddons.length === 0 &&
    data.openTickets.length === 0 &&
    data.failedWebhooks.length === 0 &&
    data.failedJobs === 0 &&
    data.aeatIssues.length === 0 &&
    data.certificatesExpiring.length === 0 &&
    data.holdedReview.length === 0 &&
    data.devicesOffline.length === 0 &&
    data.overdueCrons.length === 0 &&
    data.pendingApprovals.length === 0 &&
    data.expiringOverrides.length === 0;

  const opsCount = data
    ? data.aeatIssues.length +
      data.certificatesExpiring.length +
      data.holdedReview.length +
      data.devicesOffline.length +
      data.overdueCrons.length +
      data.failedWebhooks.length +
      (data.failedJobs > 0 ? 1 : 0)
    : 0;
  const businessCount = data
    ? data.pendingApprovals.length +
      data.addonCharges.length +
      data.pastDue.length +
      data.manualRenewalsDue.length +
      data.trialsExpiring.length +
      data.followupsDue.length +
      data.openTickets.length +
      data.expiringOverrides.length +
      data.staleSuspendedAddons.length
    : 0;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Hoy</h1>
        <p className="text-sm text-muted-foreground">
          {data ? new Date(data.date).toLocaleDateString('es-ES', { dateStyle: 'full' }) : ''}
          {data && data.urgentCount > 0 ? ` · ${data.urgentCount} acción(es) pendiente(s)` : ''}
        </p>
      </div>

      {data && <TodayKpis kpis={data.kpis} />}
      {data?.businessGoals && <TodayGoals goals={data.businessGoals} />}

      {nothing && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nada pendiente hoy. 🎉
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="business">
        <TabsList>
          <TabsTrigger value="business">
            Negocio{businessCount > 0 ? ` (${businessCount})` : ''}
          </TabsTrigger>
          <TabsTrigger value="ops">Operación{opsCount > 0 ? ` (${opsCount})` : ''}</TabsTrigger>
          <TabsTrigger value="activity">Actividad</TabsTrigger>
        </TabsList>

        <TabsContent value="business" className="mt-4 space-y-6">
          {data && <ApprovalsSection items={data.pendingApprovals} />}

          {/* Cobros de add-ons pendientes */}
          {data && data.addonCharges.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CreditCard className="size-4 text-amber-500" />
                  Cobros de add-ons pendientes ({data.addonCharges.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Add-ons de tenants que pagan el plan por Stripe: cóbralos a mano cada mes.
                  Registrar el cobro no toca el periodo del plan y reprograma el siguiente en un
                  mes.
                </p>
                {data.addonCharges.map((c) => (
                  <AddonChargeRow key={c.tenantAddonId} charge={c} />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Pagos fallidos */}
          {data && data.pastDue.length > 0 && (
            <SimpleCard
              title={`Pagos fallidos (${data.pastDue.length})`}
              icon={<AlertTriangle className="size-4 text-red-500" />}
            >
              {data.pastDue.map((t) => (
                <TenantRow key={t.id} id={t.id} name={t.name} detail={t.detail ?? 'Pago fallido'} />
              ))}
            </SimpleCard>
          )}

          {/* Renovaciones de pago manual por expirar */}
          {data && data.manualRenewalsDue.length > 0 && (
            <SimpleCard
              title={`Renovaciones manuales por expirar (${data.manualRenewalsDue.length})`}
              icon={<CalendarClock className="size-4 text-amber-500" />}
            >
              {data.manualRenewalsDue.map((r) => (
                <TenantRow
                  key={r.tenantId}
                  id={r.tenantId}
                  name={r.tenantName}
                  detail={
                    r.daysLeft < 0
                      ? `Vencida hace ${Math.abs(r.daysLeft)} d`
                      : r.daysLeft === 0
                        ? 'Vence hoy'
                        : `Vence en ${r.daysLeft} d`
                  }
                />
              ))}
            </SimpleCard>
          )}

          {/* Trials por expirar */}
          {data && data.trialsExpiring.length > 0 && (
            <SimpleCard
              title={`Trials por expirar (${data.trialsExpiring.length})`}
              icon={<CalendarClock className="size-4 text-amber-500" />}
            >
              {data.trialsExpiring.map((t) => (
                <TenantRow
                  key={t.id}
                  id={t.id}
                  name={t.name}
                  detail={t.since ? `Expira ${fmtDate(t.since)}` : 'Trial'}
                />
              ))}
            </SimpleCard>
          )}

          {/* Seguimientos vencidos */}
          {data && data.followupsDue.length > 0 && (
            <SimpleCard
              title={`Seguimientos vencidos (${data.followupsDue.length})`}
              icon={<CalendarClock className="size-4 text-amber-500" />}
            >
              {data.followupsDue.map((f) => (
                <TenantRow
                  key={f.id}
                  id={f.tenantId}
                  name={f.tenantName ?? '—'}
                  detail={`${f.title} · vence ${fmtDate(f.dueDate)}`}
                />
              ))}
            </SimpleCard>
          )}

          {/* Tickets de soporte sin responder */}
          {data && data.openTickets.length > 0 && (
            <SimpleCard
              title={`Tickets sin responder (${data.openTickets.length})`}
              icon={<LifeBuoy className="size-4 text-red-500" />}
            >
              {data.openTickets.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                >
                  <div className="min-w-0">
                    <Link href={`/admin/support/${t.id}`} className="font-medium hover:underline">
                      {t.subject}
                    </Link>
                    <span className="text-muted-foreground"> · </span>
                    <Link
                      href={`/admin/tenants/${t.tenantId}`}
                      className="text-muted-foreground hover:underline"
                    >
                      {t.tenantName}
                    </Link>
                    {t.priority === 'high' && (
                      <span className="ml-1 text-xs font-medium text-red-500">urgente</span>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t.waitingDays === 0 ? 'hoy' : `${t.waitingDays} d`}
                  </span>
                </div>
              ))}
            </SimpleCard>
          )}

          {/* Add-ons suspendidos hace mucho (candidatos a quitar) */}
          {data && data.expiringOverrides.length > 0 && (
            <SimpleCard
              title={`Pruebas gratis y cortesías que vencen (${data.expiringOverrides.length})`}
              icon={<Hourglass className="size-4 text-amber-500" />}
            >
              {data.expiringOverrides.map((o) => (
                <TenantRow
                  key={`${o.tenantId}-${o.feature}`}
                  id={o.tenantId}
                  name={`${o.tenantName} · ${o.trialAddonName ?? FEATURE_LABELS[o.feature] ?? o.feature}`}
                  detail={`${o.source === 'trial' ? 'Prueba gratis' : 'Cortesía'} · ${
                    o.daysLeft <= 0
                      ? 'vence hoy'
                      : o.daysLeft === 1
                        ? 'vence mañana'
                        : `quedan ${o.daysLeft} d`
                  }`}
                />
              ))}
            </SimpleCard>
          )}

          {data && data.staleSuspendedAddons.length > 0 && (
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
                />
              ))}
            </SimpleCard>
          )}
          {businessCount === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nada de negocio pendiente.
            </p>
          )}
        </TabsContent>

        <TabsContent value="ops" className="mt-4 space-y-6">
          {/* Facturas con problemas en la AEAT */}
          {data && data.aeatIssues.length > 0 && (
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
                  detail={`${t.count} factura(s) rechazada(s), con error o sin respuesta`}
                />
              ))}
            </SimpleCard>
          )}

          {/* Certificados de la AEAT que caducan */}
          {data && data.certificatesExpiring.length > 0 && (
            <SimpleCard
              title={`Certificados de la AEAT que caducan (${data.certificatesExpiring.length})`}
              icon={<KeyRound className="size-4 text-amber-500" />}
            >
              {data.certificatesExpiring.map((c) => (
                <TenantRow
                  key={c.id}
                  id={c.tenantId}
                  name={c.ownerName ? `${c.tenantName} · propietario ${c.ownerName}` : c.tenantName}
                  detail={
                    c.daysLeft <= 0
                      ? `Caducado el ${fmtDate(c.validTo)}`
                      : `Caduca en ${c.daysLeft} d (${fmtDate(c.validTo)})`
                  }
                />
              ))}
            </SimpleCard>
          )}

          {/* Holded: envíos para revisar */}
          {data && data.holdedReview.length > 0 && (
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
                />
              ))}
            </SimpleCard>
          )}

          {/* Cerraduras y lectores sin conexión */}
          {data && data.devicesOffline.length > 0 && (
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
                />
              ))}
            </SimpleCard>
          )}

          {/* Tareas programadas atrasadas */}
          {data && data.overdueCrons.length > 0 && (
            <SimpleCard
              title={`Tareas programadas sin ejecutarse (${data.overdueCrons.length})`}
              icon={<Clock className="size-4 text-red-500" />}
              action={{ href: '/admin/queues', label: 'Ver tareas →' }}
            >
              {data.overdueCrons.map((c) => (
                <div
                  key={c.name}
                  className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                >
                  <span className="font-mono text-xs">{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.process} · tocaba {c.nextRunAt ? fmtDateTime(c.nextRunAt) : '—'}
                  </span>
                </div>
              ))}
            </SimpleCard>
          )}

          {/* Webhooks salientes fallidos por tenant (integraciones rotas) */}
          {data && data.failedWebhooks.length > 0 && (
            <SimpleCard
              title={`Webhooks fallidos · 7 días (${data.failedWebhooks.length})`}
              icon={<AlertTriangle className="size-4 text-amber-500" />}
            >
              {data.failedWebhooks.map((w) => (
                <div
                  key={w.tenantId}
                  className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/admin/tenants/${w.tenantId}`}
                      className="font-medium hover:underline"
                    >
                      {w.tenantName}
                    </Link>
                    {w.lastError && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {w.lastError}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {w.failedCount} fallo(s) ·{' '}
                    {new Date(w.lastFailedAt).toLocaleDateString('es-ES')}
                  </span>
                </div>
              ))}
            </SimpleCard>
          )}

          {/* Colas con jobs fallidos (aviso técnico) */}
          {data && data.failedJobs > 0 && (
            <SimpleCard
              title="Colas con fallos"
              icon={<AlertTriangle className="size-4 text-red-500" />}
            >
              <div className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                <span>
                  {data.failedJobs} job(s) en estado <span className="font-medium">failed</span>.
                </span>
                <Link
                  href="/admin/queues"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Ver colas →
                </Link>
              </div>
            </SimpleCard>
          )}
          {opsCount === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">Todo funciona. 👌</p>
          )}
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          {data && <ActivityFeed items={data.activity} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AddonChargeRow({ charge }: { charge: AdminAddonChargeDueDto }) {
  const chargeAddon = useChargeAddon();
  const suspend = useAddonSuspension(charge.tenantId, 'suspend');
  const [provider, setProvider] = useState<SaasPaymentProviderValue>('cash');

  async function onCharge() {
    try {
      await chargeAddon.mutateAsync({ tenantAddonId: charge.tenantAddonId, provider });
      toast.success('Cobro registrado. Siguiente cobro en un mes.');
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
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
      <div className="min-w-0">
        <Link href={`/admin/tenants/${charge.tenantId}`} className="font-medium hover:underline">
          {charge.tenantName}
        </Link>
        <span className="text-muted-foreground"> · {charge.addonName}</span>
        {charge.overdueDays > 0 && (
          <span className="ml-1 text-xs text-red-500">(+{charge.overdueDays} d)</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="font-semibold tabular-nums">{eur(charge.amount, charge.currency)}</span>
        <Select value={provider} onValueChange={(v) => setProvider(v as SaasPaymentProviderValue)}>
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
      </div>
    </div>
  );
}

function SimpleCard({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
        {action && (
          <Link
            href={action.href}
            className="shrink-0 text-xs font-medium text-primary hover:underline"
          >
            {action.label}
          </Link>
        )}
      </CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}

function TenantRow({ id, name, detail }: { id: string; name: string; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
      <Link href={`/admin/tenants/${id}`} className="font-medium hover:underline">
        {name}
      </Link>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
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

function TodayKpis({ kpis }: { kpis: AdminTodayKpisDto }) {
  const items: { label: string; value: string; href: string; warn?: boolean }[] = [
    { label: 'MRR (activos)', value: eur(kpis.mrr), href: '/admin/metrics' },
    { label: 'Cobrado 7 días', value: eur(kpis.collected7d), href: '/admin/billing-calendar' },
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
    { label: 'Altas del mes', value: String(kpis.newThisMonth), href: '/admin/tenants' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((i) => (
        <Link
          key={i.label}
          href={i.href}
          className="rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40"
        >
          <p className="text-xs text-muted-foreground">{i.label}</p>
          <p className={`text-lg font-semibold ${i.warn ? 'text-destructive' : ''}`}>{i.value}</p>
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

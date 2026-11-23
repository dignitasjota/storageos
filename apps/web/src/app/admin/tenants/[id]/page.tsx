'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AdminTenantActionSchema,
  type AdminTenantActionInput,
  SuspendTenantSchema,
  type SuspendTenantInput,
  ExtendTrialSchema,
  type ExtendTrialInput,
  ImpersonateSchema,
  type ImpersonateInput,
} from '@storageos/shared';
import { Loader2, Mail, MoreVertical, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { AccountActivationBanner } from './account-activation-banner';
import { AiUsageCard } from './ai-usage-card';
import { ApprovalRequestsCard } from './approval-requests-card';
import { FeatureOverridesCard } from './feature-overrides-card';
import { OnboardingCard } from './onboarding-card';
import { PlatformInvoicesCard } from './platform-invoices-card';
import { RequestApprovalDialog } from './request-approval-dialog';
import { ResetDataDialog } from './reset-data-dialog';
import { SaasPaymentsCard } from './saas-payments-card';
import { TenantAccountCard } from './tenant-account-card';
import { TenantAddonsCard } from './tenant-addons-card';
import { TenantBusinessCard } from './tenant-business-card';
import { TenantConfigCard } from './tenant-config-card';
import { TenantCustomersDialog } from './tenant-customers-dialog';
import { TenantEditDialog } from './tenant-edit-dialog';
import { TenantEmailDialog } from './tenant-email-dialog';
import { TenantFacilitiesDialog } from './tenant-facilities-dialog';
import { TenantFollowupsCard } from './tenant-followups-card';
import { TenantHealthCard } from './tenant-health-card';
import { TenantInteractionsCard } from './tenant-interactions-card';
import { TenantInvoicingDialog } from './tenant-invoicing-dialog';
import { TenantNotesCard } from './tenant-notes-card';
import { TenantSummaryCard } from './tenant-summary-card';
import { TenantTimelineCard } from './tenant-timeline-card';
import { TenantUsersDialog } from './tenant-users-dialog';
import { WhatsappAiCard } from './whatsapp-ai-card';

import { AdminError } from '@/components/admin/admin-error';
import { PlatformEmailLog } from '@/components/admin/platform-email-log';
import { TenantRepCard } from '@/components/admin/sales/tenant-rep-card';
import { SupportTicketList } from '@/components/admin/support-ticket-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { adminApiFetchBlob } from '@/lib/admin/api';
import { CHURN_REASONS } from '@/lib/admin/churn';
import {
  useAdminSubscriptionPlans,
  useAdminTenant,
  useTenantDataExport,
  useAnonymizeTenant,
  useChangePlan,
  useChangePlanPreview,
  useExtendTrial,
  useEndTrial,
  useSetBillingExempt,
  useAdminTenantAccount,
  useAdminTenantSepaMandate,
  useSetBillingMode,
  useSwitchToManualBilling,
  useImpersonateTenant,
  useReactivateTenant,
  useSuspendTenant,
} from '@/lib/admin/hooks';
import { subscriptionStatusLabel, tenantStatusLabel } from '@/lib/admin/labels';
import { rememberTenant } from '@/lib/admin/recent-tenants';
import { useAnonymizePreview } from '@/lib/admin/tenant-tools-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { IMPERSONATION_HANDOFF_KEY, IMPERSONATION_URL_PARAM } from '@/lib/auth/impersonation';

/** Pestañas de la ficha (las que admite `?tab=`). */
const TENANT_TABS = [
  'general',
  'business',
  'timeline',
  'config',
  'payments',
  'conversations',
  'followups',
  'tickets',
  'emails',
];

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  trial: 'secondary',
  active: 'default',
  suspended: 'destructive',
  cancelled: 'outline',
};

export default function AdminTenantDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  // `?tab=payments` abre directamente esa pestaña (enlaces desde Cobros
  // pendientes); una desconocida abre General y la URL sigue a la pestaña.
  const searchParams = useSearchParams();
  const router = useRouter();
  const requestedTab = searchParams.get('tab');
  const tab = requestedTab && TENANT_TABS.includes(requestedTab) ? requestedTab : 'general';
  const setTab = (next: string) => {
    const qs = new URLSearchParams(searchParams.toString());
    if (next === 'general') qs.delete('tab');
    else qs.set('tab', next);
    const query = qs.toString();
    router.replace(`/admin/tenants/${id}${query ? `?${query}` : ''}`, { scroll: false });
  };
  const tenant = useAdminTenant(id);
  const dataExport = useTenantDataExport(id);
  // El rol `support` no edita, suspende, impersona ni toca la suscripción (403 en el API).
  const canEdit = useIsSuperadmin();
  const [approvalOpen, setApprovalOpen] = useState(false);

  const [dialog, setDialog] = useState<
    | 'suspend'
    | 'reactivate'
    | 'extendTrial'
    | 'endTrial'
    | 'impersonate'
    | 'anonymize'
    | 'reset'
    | null
  >(null);
  const [usersOpen, setUsersOpen] = useState(false);
  const [invoicingOpen, setInvoicingOpen] = useState(false);
  const [facilitiesOpen, setFacilitiesOpen] = useState(false);
  const [customersOpen, setCustomersOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  // Para los «recientes» de la búsqueda ⌘K.
  const tenantName = tenant.data?.name;
  useEffect(() => {
    if (tenantName) rememberTenant({ id, name: tenantName });
  }, [id, tenantName]);

  if (tenant.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!tenant.data) {
    return (
      <div className="px-4 py-4 sm:px-6 sm:py-6">
        <AdminError onRetry={() => void tenant.refetch()} />
      </div>
    );
  }

  const t = tenant.data;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{t.name}</h1>
            <Badge variant={STATUS_VARIANT[t.status] ?? 'secondary'}>
              {tenantStatusLabel(t.status)}
            </Badge>
            {t.billingExempt && (
              <Badge
                variant="outline"
                className="border-violet-300 text-violet-700 dark:border-violet-800 dark:text-violet-300"
              >
                Exento
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">/{t.slug}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Acciones frecuentes: Editar y Email como icono (aria-label + title). */}
          {canEdit && (
            <Button
              variant="outline"
              size="icon"
              aria-label="Editar"
              title="Editar"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="size-4" />
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            aria-label="Enviar email"
            title="Enviar email"
            onClick={() => setEmailOpen(true)}
          >
            <Mail className="size-4" />
          </Button>
          {!canEdit && (
            <Button variant="outline" onClick={() => setApprovalOpen(true)}>
              Pedir aprobación
            </Button>
          )}
          {canEdit && t.status !== 'suspended' && (
            <Button variant="destructive" onClick={() => setDialog('suspend')}>
              Suspender
            </Button>
          )}
          {canEdit && t.status === 'suspended' && (
            <Button onClick={() => setDialog('reactivate')}>Reactivar</Button>
          )}
          {/* Extender/Finalizar trial se movieron a la card «Suscripción» (acción
              contextual junto al estado del trial). */}
          {/* Acciones poco frecuentes / sensibles bajo un menú (Anonimizar es
              irreversible: mejor que no esté a un clic accidental). */}
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Más acciones"
                  title="Más acciones"
                >
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setDialog('impersonate')}>
                  Impersonar
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={dataExport.isPending}
                  onClick={() =>
                    dataExport.mutate(undefined, {
                      onSuccess: (r) => {
                        toast.success('Exportación lista. Se descarga el Excel.');
                        window.location.href = r.url;
                      },
                      onError: () => toast.error('No se pudo generar la exportación.'),
                    })
                  }
                >
                  {dataExport.isPending ? 'Exportando datos…' : 'Exportar datos (Excel)'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDialog('reset')}
                >
                  Vaciar los datos de prueba
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDialog('anonymize')}
                >
                  Anonimizar (RGPD)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {t.owner && !t.owner.emailVerified && (
        <AccountActivationBanner tenantId={t.id} owner={t.owner} />
      )}

      <TenantSummaryCard tenantId={t.id} />
      <ApprovalRequestsCard tenantId={t.id} />
      <RequestApprovalDialog tenantId={t.id} open={approvalOpen} onOpenChange={setApprovalOpen} />

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="business">Negocio</TabsTrigger>
          <TabsTrigger value="timeline">Historial</TabsTrigger>
          <TabsTrigger value="config">Configuración</TabsTrigger>
          <TabsTrigger value="payments">Pagos</TabsTrigger>
          <TabsTrigger value="conversations">Conversaciones</TabsTrigger>
          <TabsTrigger value="followups">Seguimientos</TabsTrigger>
          <TabsTrigger value="tickets">Tickets</TabsTrigger>
          <TabsTrigger value="emails">Correos</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Datos generales</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row label="ID" value={t.id} mono />
                <Row label="Email de facturación" value={t.billingEmail ?? '—'} />
                <Row label="País" value={t.country} />
                <Row label="Divisa" value={t.currency} />
                <Row label="Creado" value={new Date(t.createdAt).toLocaleDateString('es-ES')} />
                <Row
                  label="Fin trial"
                  value={t.trialEndsAt ? new Date(t.trialEndsAt).toLocaleDateString('es-ES') : '—'}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Suscripción</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {t.subscription ? (
                  <>
                    <Row
                      label="Plan"
                      value={t.subscription.planName ?? t.subscription.planSlug ?? '—'}
                    />
                    <Row label="Estado" value={subscriptionStatusLabel(t.subscription.status)} />
                    <Row
                      label="Fin periodo"
                      value={
                        // Una cuenta exenta no se cobra nunca → su fin de periodo
                        // es irrelevante (no expira ni entra en dunning).
                        t.billingExempt
                          ? 'Sin vencimiento (exenta)'
                          : t.subscription.currentPeriodEnd
                            ? new Date(t.subscription.currentPeriodEnd).toLocaleDateString('es-ES')
                            : '—'
                      }
                    />
                    <Row
                      label="Stripe sub. ID"
                      value={t.subscription.stripeSubscriptionId ?? '—'}
                      mono
                    />
                    <Row
                      label="Modo de cobro"
                      value={
                        <Badge variant="outline">
                          {BILLING_MODE_LABELS[t.subscription.billingMode] ??
                            t.subscription.billingMode}
                        </Badge>
                      }
                    />
                    {canEdit && (
                      <>
                        <ChangePlanControl
                          tenantId={id}
                          currentSlug={t.subscription.planSlug ?? null}
                        />
                        <BillingModeControl
                          tenantId={id}
                          billingMode={t.subscription.billingMode}
                        />
                      </>
                    )}
                  </>
                ) : (
                  <p className="text-muted-foreground">Sin suscripción activa.</p>
                )}
                {/* Acciones de trial: en prueba, o con la prueba vencida sin pagar
                    (en solo lectura), que se puede reabrir. */}
                {canEdit && (t.status === 'trial' || t.subscription?.status === 'expired') && (
                  <div className="flex flex-wrap gap-2 border-t pt-3">
                    {t.status !== 'trial' && (
                      <p className="w-full text-xs text-amber-700 dark:text-amber-300">
                        Sin pagar: el panel del cliente está en solo lectura.
                      </p>
                    )}
                    <Button variant="outline" size="sm" onClick={() => setDialog('extendTrial')}>
                      {t.status === 'trial' ? 'Extender trial' : 'Reabrir la prueba'}
                    </Button>
                    {t.status === 'trial' && (
                      <Button variant="outline" size="sm" onClick={() => setDialog('endTrial')}>
                        Finalizar prueba
                      </Button>
                    )}
                  </div>
                )}
                {!t.billingExempt && t.billingMissing.length > 0 && (
                  <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    Sus facturas de suscripción saldrán incompletas: falta{' '}
                    {t.billingMissing.join(', ')}. Complétalo en «Editar» o pídeselo al tenant
                    (Ajustes → Suscripción).
                  </p>
                )}
                {/* Exención de facturación (cuenta interna): fuera de las métricas. */}
                {canEdit && (
                  <BillingExemptControl
                    tenantId={id}
                    exempt={t.billingExempt}
                    onStripe={!!t.subscription?.stripeSubscriptionId}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Uso</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <Stat
                  label="Usuarios activos"
                  value={t.userCount}
                  onClick={() => setUsersOpen(true)}
                />
                <Stat
                  label="Locales"
                  value={t.facilityCount}
                  onClick={() => setFacilitiesOpen(true)}
                />
                <Stat
                  label="Inquilinos"
                  value={t.customerCount}
                  onClick={() => setCustomersOpen(true)}
                />
                <Stat
                  label="Contratos vigentes"
                  value={t.contractCount}
                  onClick={() => setInvoicingOpen(true)}
                />
              </CardContent>
            </Card>

            <TenantHealthCard tenantId={id} />
            <OnboardingCard tenantId={id} />
            <FeatureOverridesCard tenantId={id} />
            <AiUsageCard tenantId={id} />
            <WhatsappAiCard tenantId={id} />
            <TenantNotesCard tenantId={id} />
            <TenantRepCard tenantId={id} />
          </div>
        </TabsContent>

        <TabsContent value="business" className="mt-4">
          <TenantBusinessCard tenantId={id} />
        </TabsContent>

        <TabsContent value="timeline" className="mt-4">
          <TenantTimelineCard tenantId={id} />
        </TabsContent>

        <TabsContent value="payments" className="mt-4 space-y-4">
          <TenantAccountCard tenantId={id} />
          <div className="flex justify-end">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/quote?tenantId=${id}`}>Simular cuota y proponer</Link>
            </Button>
          </div>
          <TenantAddonsCard tenantId={id} tenantName={t.name} />
          <SaasPaymentsCard tenantId={id} />
          <PlatformInvoicesCard tenantId={id} />
        </TabsContent>

        <TabsContent value="conversations" className="mt-4">
          <TenantInteractionsCard tenantId={id} />
        </TabsContent>

        <TabsContent value="config" className="mt-4">
          <TenantConfigCard tenantId={id} />
        </TabsContent>

        <TabsContent value="followups" className="mt-4">
          <TenantFollowupsCard tenantId={id} />
        </TabsContent>

        <TabsContent value="emails" className="mt-4">
          <PlatformEmailLog tenantId={id} />
        </TabsContent>
        <TabsContent value="tickets" className="mt-4">
          <SupportTicketList
            filters={{ tenantId: id }}
            showTenant={false}
            emptyText="Sin tickets con este tenant."
          />
        </TabsContent>
      </Tabs>

      <TenantUsersDialog open={usersOpen} tenantId={t.id} onClose={() => setUsersOpen(false)} />
      <TenantInvoicingDialog
        open={invoicingOpen}
        tenantId={t.id}
        onClose={() => setInvoicingOpen(false)}
      />
      <TenantFacilitiesDialog
        open={facilitiesOpen}
        tenantId={t.id}
        onClose={() => setFacilitiesOpen(false)}
      />
      <TenantCustomersDialog
        open={customersOpen}
        tenantId={t.id}
        onClose={() => setCustomersOpen(false)}
      />
      <TenantEditDialog tenant={t} open={editOpen} onClose={() => setEditOpen(false)} />
      <TenantEmailDialog tenantId={t.id} open={emailOpen} onClose={() => setEmailOpen(false)} />

      <SuspendDialog
        open={dialog === 'suspend'}
        tenantId={t.id}
        autoCharge={
          !t.billingExempt &&
          ['stripe', 'sepa', 'redsys'].includes(t.subscription?.billingMode ?? 'manual')
            ? (BILLING_MODE_LABELS[t.subscription?.billingMode ?? ''] ??
              t.subscription?.billingMode ??
              null)
            : null
        }
        onClose={() => setDialog(null)}
      />
      <ReactivateDialog
        open={dialog === 'reactivate'}
        tenantId={t.id}
        pastDue={t.subscription?.status === 'past_due' && !t.billingExempt}
        onStripe={t.subscription?.billingMode === 'stripe' && !!t.subscription.stripeSubscriptionId}
        onClose={() => setDialog(null)}
      />
      <ExtendTrialDialog
        open={dialog === 'extendTrial'}
        tenantId={t.id}
        onClose={() => setDialog(null)}
      />
      <EndTrialDialog
        open={dialog === 'endTrial'}
        tenantId={t.id}
        onClose={() => setDialog(null)}
      />
      <ImpersonateDialog
        open={dialog === 'impersonate'}
        tenantId={t.id}
        onClose={() => setDialog(null)}
      />
      <ResetDataDialog
        open={dialog === 'reset'}
        tenantId={t.id}
        tenantSlug={t.slug}
        onClose={() => setDialog(null)}
      />
      <AnonymizeDialog
        open={dialog === 'anonymize'}
        tenantId={t.id}
        tenantSlug={t.slug}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs' : ''}>{value}</span>
    </div>
  );
}

function Stat({ label, value, onClick }: { label: string; value: number; onClick?: () => void }) {
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="group rounded-md text-left transition-colors hover:bg-muted/60 -mx-1 px-1 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold text-primary group-hover:underline">{value}</div>
      </button>
    );
  }
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

// ============================================================================
// Dialogs
// ============================================================================

function SuspendDialog({
  open,
  tenantId,
  autoCharge,
  onClose,
}: {
  open: boolean;
  tenantId: string;
  /** Cómo se le cobra la cuota si es automático (Stripe, SEPA, Redsys); null si no. */
  autoCharge: string | null;
  onClose: () => void;
}) {
  const suspend = useSuspendTenant();
  const form = useForm<SuspendTenantInput>({
    resolver: zodResolver(SuspendTenantSchema),
    defaultValues: { reason: '' },
  });

  async function onSubmit(values: SuspendTenantInput) {
    try {
      await suspend.mutateAsync({ id: tenantId, input: values });
      toast.success('Tenant suspendido.');
      form.reset();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('Error de red.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspender tenant</DialogTitle>
          <DialogDescription>
            Su equipo solo podrá consultar y pagar la suscripción, sin crear ni cambiar nada. Los
            cobros automáticos y los correos a sus inquilinos se retienen; el acceso de los
            inquilinos al local no se corta. Si el motivo es otro que el impago, un pago de la cuota
            no lo reactiva: lo reactivas tú.
          </DialogDescription>
        </DialogHeader>
        {autoCharge && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Su cuota se cobra sola ({autoCharge}): suspenderlo no la para y se le seguirá cobrando.
            Si deja de ser cliente, pásalo antes a pago manual.
          </p>
        )}
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="churnReason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Motivo de baja (churn)</FormLabel>
                  <Select value={field.value ?? ''} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecciona un motivo (opcional)" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CHURN_REASONS.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nota</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} placeholder="Detalle interno de la baja..." />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" variant="destructive" disabled={form.formState.isSubmitting}>
                Suspender
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ReactivateDialog({
  open,
  tenantId,
  pastDue,
  onStripe,
  onClose,
}: {
  open: boolean;
  tenantId: string;
  /** La suscripción sigue con un pago pendiente. */
  pastDue: boolean;
  onStripe: boolean;
  onClose: () => void;
}) {
  const reactivate = useReactivateTenant();
  const [forgive, setForgive] = useState(false);
  const form = useForm<AdminTenantActionInput>({
    resolver: zodResolver(AdminTenantActionSchema),
    defaultValues: { reason: '' },
  });

  async function onSubmit(values: AdminTenantActionInput) {
    try {
      await reactivate.mutateAsync({
        id: tenantId,
        input: { ...values, ...(forgive ? { forgivePeriod: true } : {}) },
      });
      toast.success(forgive ? 'Tenant reactivado y deuda perdonada.' : 'Tenant reactivado.');
      setForgive(false);
      form.reset();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('Error de red.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reactivar tenant</DialogTitle>
          <DialogDescription>Su equipo vuelve a poder trabajar con normalidad.</DialogDescription>
        </DialogHeader>
        {pastDue && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Su suscripción sigue con un pago pendiente y verá el aviso de pago. Registra el pago en
            la pestaña «Pagos»: si no, el escalado de impagos no vuelve a actuar hasta el siguiente
            periodo.
          </p>
        )}
        {pastDue && !onStripe && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={forgive}
              onCheckedChange={(v) => setForgive(v === true)}
              className="mt-0.5"
            />
            <span>
              Perdonar lo que debe
              <span className="block text-xs text-muted-foreground">
                No se le reclama ninguna de las cuotas vencidas: su suscripción queda al día y el
                próximo cobro es un mes después del vencimiento (o dentro de 30 días, si esa fecha
                ya ha pasado).
              </span>
            </span>
          </label>
        )}
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Motivo</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} placeholder="Pago recibido, malentendido, ..." />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                Reactivar
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function EndTrialDialog({
  open,
  tenantId,
  onClose,
}: {
  open: boolean;
  tenantId: string;
  onClose: () => void;
}) {
  const endTrial = useEndTrial();
  const form = useForm<AdminTenantActionInput>({
    resolver: zodResolver(AdminTenantActionSchema),
    defaultValues: { reason: '' },
  });

  async function onSubmit(values: AdminTenantActionInput) {
    try {
      await endTrial.mutateAsync({ id: tenantId, input: values });
      toast.success('Prueba finalizada. La cuenta queda en solo lectura hasta que pague.');
      form.reset();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('Error de red.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Finalizar periodo de prueba</DialogTitle>
          <DialogDescription>
            Sin pago, la cuenta conserva su plan pero queda en <strong>solo lectura</strong> hasta
            que pague (sus inquilinos y su web siguen funcionando). Si el cliente va a pagar,
            registra antes el pago (eso lo activa en su plan). La prueba también se cierra sola al
            pagar.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Motivo</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={3}
                      placeholder="Cliente que paga por transferencia…"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                Finalizar prueba
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ExtendTrialDialog({
  open,
  tenantId,
  onClose,
}: {
  open: boolean;
  tenantId: string;
  onClose: () => void;
}) {
  const extend = useExtendTrial();
  const form = useForm<ExtendTrialInput>({
    resolver: zodResolver(ExtendTrialSchema),
    defaultValues: { days: 7, reason: '' },
  });

  async function onSubmit(values: ExtendTrialInput) {
    try {
      await extend.mutateAsync({ id: tenantId, input: values });
      toast.success(`Trial extendido ${values.days} días.`);
      form.reset({ days: 7, reason: '' });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('Error de red.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Extender trial</DialogTitle>
          <DialogDescription>Suma días al periodo de prueba actual.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="days"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Días</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      value={field.value}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Motivo</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} placeholder="Petición del cliente, ..." />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                Extender
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ImpersonateDialog({
  open,
  tenantId,
  onClose,
}: {
  open: boolean;
  tenantId: string;
  onClose: () => void;
}) {
  const impersonate = useImpersonateTenant();
  // El navegador bloquea las ventanas que no se abren al pulsar: si no se pudo
  // abrir, se enseña un enlace para abrirla a mano.
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const form = useForm<ImpersonateInput>({
    resolver: zodResolver(ImpersonateSchema),
    defaultValues: { reason: '', readOnly: true },
  });

  async function onSubmit(values: ImpersonateInput) {
    // La pestaña se abre ya (con el clic); la petición la navega después.
    const tab = window.open('about:blank', '_blank');
    try {
      const session = await impersonate.mutateAsync({ id: tenantId, input: values });
      // El panel del tenant (pestaña nueva, mismo origen) recoge el token solo
      // si la URL trae este código de un solo uso; luego lo borra de aquí.
      const nonce = crypto.randomUUID();
      window.localStorage.setItem(
        IMPERSONATION_HANDOFF_KEY,
        JSON.stringify({
          accessToken: session.accessToken,
          tenantName: session.tenantName,
          tenantSlug: session.tenantSlug,
          expiresAt: Date.now() + session.expiresIn * 1000,
          readOnly: session.readOnly,
          nonce,
        }),
      );
      const url = `/dashboard?${IMPERSONATION_URL_PARAM}=${nonce}`;
      // Si nadie lo recoge en 2 minutos, el código se borra.
      window.setTimeout(() => {
        const raw = window.localStorage.getItem(IMPERSONATION_HANDOFF_KEY);
        if (raw?.includes(nonce)) window.localStorage.removeItem(IMPERSONATION_HANDOFF_KEY);
      }, 120_000);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
        toast.success(`Abierto ${session.tenantName} en una pestaña nueva.`);
        form.reset();
        onClose();
      } else {
        setManualUrl(url);
      }
    } catch (err) {
      tab?.close();
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('Error de red.');
    }
  }

  function close() {
    setManualUrl(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Impersonar tenant</DialogTitle>
          <DialogDescription>
            Abre el panel del tenant en una pestaña nueva durante un tiempo limitado, con tu nombre
            en el registro de auditoría. Úsalo solo para soporte.
          </DialogDescription>
        </DialogHeader>
        {manualUrl ? (
          <div className="space-y-3 text-sm">
            <p>El navegador no ha dejado abrir la pestaña. Ábrela tú:</p>
            <Button asChild>
              <a href={manualUrl} target="_blank" rel="noopener noreferrer" onClick={close}>
                Abrir el panel
              </a>
            </Button>
          </div>
        ) : (
          <Form {...form}>
            <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
              <FormField
                control={form.control}
                name="readOnly"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                    </FormControl>
                    <div className="space-y-0.5">
                      <FormLabel className="font-normal">Solo lectura</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        Ves lo mismo que el propietario pero no puedes cambiar nada. Desmárcalo solo
                        si necesitas hacer un cambio por él; aun así no podrás invitar usuarios,
                        traspasar la propiedad, crear claves de API o webhooks ni enlaces del área
                        de clientes.
                      </p>
                    </div>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Motivo</FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={3} placeholder="Investigación incidencia #1234" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  Iniciar impersonación
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AnonymizeDialog({
  open,
  tenantId,
  tenantSlug,
  onClose,
}: {
  open: boolean;
  tenantId: string;
  tenantSlug: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const anonymize = useAnonymizeTenant();
  const preview = useAnonymizePreview(tenantId, open);
  const [confirmSlug, setConfirmSlug] = useState('');
  const [exported, setExported] = useState(false);
  const form = useForm<AdminTenantActionInput>({
    resolver: zodResolver(AdminTenantActionSchema),
    defaultValues: { reason: '' },
  });

  const slugMatches = confirmSlug.trim() === tenantSlug;

  function close() {
    setConfirmSlug('');
    setExported(false);
    form.reset();
    onClose();
  }

  async function onSubmit(values: AdminTenantActionInput) {
    if (!slugMatches || !exported) return;
    try {
      const result = await anonymize.mutateAsync({
        id: tenantId,
        input: { ...values, exported: true },
      });
      toast.success(
        `Tenant anonimizado: ${result.anonymizedCustomers} inquilino(s) y ${result.anonymizedUsers} usuario(s).`,
      );
      close();
      // El tenant queda con deletedAt; ya no es accesible en el detalle.
      router.push('/admin/tenants');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('Error de red.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Anonimizar tenant (RGPD)</DialogTitle>
          <DialogDescription>
            Acción <strong>irreversible</strong>. Se anonimizan todos los inquilinos y usuarios del
            tenant, se borran sus documentos y métodos de pago, se revocan las sesiones, deja de
            cobrársele la cuota (Stripe, mandato SEPA y tarjeta) y la cuenta queda cancelada. Las
            facturas se conservan por obligación fiscal. Si el cliente quiere sus datos, descárgalos
            antes con «Exportar datos (Excel)» del menú.
          </DialogDescription>
        </DialogHeader>
        {preview.isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Revisando lo que se va a borrar…
          </p>
        )}
        {preview.isError && (
          <AdminError
            message="No se pudo revisar lo que se va a borrar."
            onRetry={() => void preview.refetch()}
          />
        )}
        {preview.data && (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Se anonimizan {preview.data.customers} inquilino(s) y {preview.data.users} usuario(s).
              Se conservan {preview.data.invoicesKept} factura(s).
            </p>
            {preview.data.warnings.map((w) => (
              <p
                key={w.code}
                className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
              >
                {w.message}
              </p>
            ))}
          </div>
        )}
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Motivo</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={3}
                      placeholder="Solicitud de baja y derecho al olvido del cliente"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <Label htmlFor="confirm-slug">
                Escribe <span className="font-mono text-xs">{tenantSlug}</span> para confirmar
              </Label>
              <Input
                id="confirm-slug"
                value={confirmSlug}
                onChange={(e) => setConfirmSlug(e.target.value)}
                autoComplete="off"
                placeholder={tenantSlug}
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={exported}
                onCheckedChange={(v) => setExported(v === true)}
                className="mt-0.5"
              />
              <span>Ya he exportado sus datos (o el cliente no los quiere)</span>
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={!preview.data || !slugMatches || !exported || form.formState.isSubmitting}
              >
                Anonimizar definitivamente
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const BILLING_MODE_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  manual: 'Manual',
  sepa: 'SEPA (BBVA)',
  redsys: 'Tarjeta guardada (Redsys)',
};

/**
 * Modo de cobro de la suscripción + estado del mandato SEPA + los dos
 * destinos posibles ('manual'/'sepa'; a 'stripe' solo se llega vía Checkout
 * del propio tenant, nunca desde aquí). Sustituye al antiguo
 * `SwitchToManualControl` (ahora generalizado: «pasar a manual» funciona
 * igual viniendo de Stripe o de SEPA).
 */
function BillingModeControl({ tenantId, billingMode }: { tenantId: string; billingMode: string }) {
  const mandate = useAdminTenantSepaMandate(tenantId);
  const account = useAdminTenantAccount(tenantId);
  const sepaInProgress = account.data?.sepaInProgress ?? false;
  const fromLabel = BILLING_MODE_LABELS[billingMode] ?? billingMode;
  const switchToManual = useSwitchToManualBilling();
  const setSepa = useSetBillingMode();
  const [confirmMode, setConfirmMode] = useState<'manual' | 'sepa' | null>(null);
  const hasMandate = mandate.data !== null && mandate.data !== undefined;
  const activeMandate = hasMandate && mandate.data!.status === 'active';

  async function confirm() {
    if (!confirmMode) return;
    try {
      if (confirmMode === 'manual') {
        await switchToManual.mutateAsync(tenantId);
      } else {
        await setSepa.mutateAsync({ id: tenantId, mode: 'sepa' });
      }
      toast.success(
        confirmMode === 'manual'
          ? 'Suscripción pasada a pago manual.'
          : 'Suscripción pasada a SEPA.',
      );
      setConfirmMode(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }
  const pending = switchToManual.isPending || setSepa.isPending;

  return (
    <div className="space-y-2 border-t pt-3">
      <Row
        label="Mandato SEPA"
        value={
          mandate.isLoading
            ? '…'
            : mandate.isError
              ? 'No se pudo cargar'
              : hasMandate
                ? `····${mandate.data!.ibanLast4} (${mandate.data!.status === 'active' ? 'activo' : mandate.data!.status === 'expired' ? 'caducado' : 'cancelado'}${
                    mandate.data!.signatureStatus === 'signed'
                      ? `, firmado por ${mandate.data!.signedByName ?? 'el tenant'}`
                      : mandate.data!.signatureStatus === 'external'
                        ? ', firmado antes de la firma en la app'
                        : ''
                  })`
                : 'Sin mandato'
        }
      />
      <div className="flex flex-wrap gap-2">
        {hasMandate && mandate.data!.signatureStatus === 'signed' && (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const blob = await adminApiFetchBlob(
                  `/admin/tenants/${tenantId}/sepa-mandate/document`,
                );
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `mandato-${mandate.data!.reference}.pdf`;
                a.click();
                URL.revokeObjectURL(url);
              } catch {
                toast.error('No se pudo descargar el mandato.');
              }
            }}
          >
            Descargar mandato
          </Button>
        )}
        {billingMode !== 'manual' && (
          <Button variant="secondary" size="sm" onClick={() => setConfirmMode('manual')}>
            Pasar a manual
          </Button>
        )}
        {billingMode !== 'sepa' && (
          <Button
            variant="secondary"
            size="sm"
            disabled={!activeMandate}
            title={
              activeMandate
                ? undefined
                : 'El tenant necesita un mandato SEPA activo (Ajustes → Suscripción)'
            }
            onClick={() => setConfirmMode('sepa')}
          >
            Pasar a SEPA
          </Button>
        )}
      </div>
      <Dialog open={confirmMode !== null} onOpenChange={(o) => !o && setConfirmMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmMode === 'manual' ? 'Pasar a pago manual' : 'Pasar a cobro por SEPA'}
            </DialogTitle>
            <DialogDescription>
              {confirmMode === 'manual'
                ? `Deja de cobrarse por ${fromLabel}${billingMode === 'stripe' ? ' (se cancela la suscripción en Stripe)' : ''} y las próximas cuotas se registran a mano. Conserva el periodo ya pagado; si está en prueba o en solo lectura sigue igual, y si debe cuotas las sigue debiendo.`
                : `Deja de cobrarse por ${fromLabel}${billingMode === 'stripe' ? ' (se cancela la suscripción en Stripe)' : ''} y las próximas cuotas se domiciliarán por SEPA con el mandato ya autorizado.`}
            </DialogDescription>
          </DialogHeader>
          {sepaInProgress && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              Hay un adeudo SEPA de su cuota en el banco sin confirmar: si se cobra, regístralo en
              la remesa aunque haya cambiado la forma de cobro.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmMode(null)}>
              Cancelar
            </Button>
            <Button onClick={confirm} disabled={pending}>
              {pending ? 'Procesando…' : 'Confirmar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BillingExemptControl({
  tenantId,
  exempt,
  onStripe,
}: {
  tenantId: string;
  exempt: boolean;
  onStripe: boolean;
}) {
  const setExempt = useSetBillingExempt();
  async function toggle() {
    try {
      await setExempt.mutateAsync({ id: tenantId, exempt: !exempt });
      toast.success(
        exempt ? 'Exención retirada.' : 'Cuenta marcada como exenta (fuera de las métricas).',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }
  return (
    <div className="border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Exenta de facturación</p>
          <p className="text-xs text-muted-foreground">
            Cuenta interna/demo/partner: opera con su plan sin pagar y no cuenta en el MRR,
            ingresos, churn ni trials.
          </p>
        </div>
        <Button
          variant={exempt ? 'outline' : 'secondary'}
          size="sm"
          onClick={toggle}
          disabled={setExempt.isPending}
        >
          {exempt ? 'Quitar exención' : 'Marcar exenta'}
        </Button>
      </div>
      {exempt && onStripe && (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Sigue suscrita en Stripe, que le seguirá cobrando. Usa «Pasar a pago manual» para cancelar
          la suscripción de Stripe.
        </p>
      )}
    </div>
  );
}

function ChangePlanControl({
  tenantId,
  currentSlug,
}: {
  tenantId: string;
  currentSlug: string | null;
}) {
  const plans = useAdminSubscriptionPlans({ assignable: true });
  const change = useChangePlan();
  const [slug, setSlug] = useState(currentSlug ?? '');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  // Si su plan actual no se puede asignar (gratuito o desactivado), el
  // desplegable no lo tiene: arranca sin plan elegido en vez de enseñar el
  // primero como si fuera el suyo.
  const assignable = (plans.data ?? []).some((p) => p.slug === currentSlug);
  const selected = assignable || slug !== currentSlug ? slug : '';
  const changing = Boolean(selected) && selected !== currentSlug;
  const preview = useChangePlanPreview(tenantId, selected, changing);
  const eurFmt = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

  function ask() {
    if (!changing) {
      toast.error('Elige un plan distinto al actual.');
      return;
    }
    if (reason.trim().length < 3) {
      toast.error('Indica un motivo.');
      return;
    }
    setConfirming(true);
  }

  async function submit() {
    try {
      await change.mutateAsync({
        id: tenantId,
        input: { planSlug: selected, reason: reason.trim() },
      });
      toast.success('Plan cambiado.');
      setReason('');
      setConfirming(false);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('No se pudo cambiar el plan.');
    }
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <Label className="text-xs text-muted-foreground">Cambiar plan</Label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selected}
          onChange={(e) => setSlug(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {!assignable && (
            <option value="" disabled>
              Elige un plan
            </option>
          )}
          {(plans.data ?? []).map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name} ({p.slug})
            </option>
          ))}
        </select>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Motivo"
          className="h-9 w-40"
        />
        <Button size="sm" onClick={ask} disabled={change.isPending}>
          Cambiar
        </Button>
      </div>
      <Dialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambiar de plan</DialogTitle>
            <DialogDescription>
              {preview.data
                ? `${preview.data.currentPlanName} → ${preview.data.newPlanName}: ${eurFmt(preview.data.newPriceMonthly)}/mes.`
                : 'Se cambia su plan.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {preview.data?.inTrial && (
              <p>Está en prueba: cambiar de plan termina la prueba y empieza a pagar.</p>
            )}
            {preview.data?.chargedByStripe && (
              <p>Paga por Stripe: Stripe prorratea la diferencia en su próxima factura.</p>
            )}
            {(preview.data?.owedPeriods ?? 0) > 0 && (
              <p className="text-amber-700 dark:text-amber-300">
                Debe {preview.data!.owedPeriods}{' '}
                {preview.data!.owedPeriods === 1 ? 'cuota' : 'cuotas'}: se le reclamarán al precio
                del plan nuevo.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void submit()} disabled={change.isPending}>
              {change.isPending ? 'Cambiando…' : 'Cambiar de plan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview del impacto del cambio de plan */}
      {changing && preview.data && (
        <div className="space-y-1.5 rounded-md border p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {preview.data.currentPlanName} → {preview.data.newPlanName}
            </span>
            <span
              className={
                preview.data.priceDelta > 0
                  ? 'font-medium text-emerald-600 dark:text-emerald-400'
                  : preview.data.priceDelta < 0
                    ? 'font-medium text-amber-600 dark:text-amber-400'
                    : 'text-muted-foreground'
              }
            >
              {preview.data.priceDelta >= 0 ? '+' : ''}
              {eurFmt(preview.data.priceDelta)}/mes
            </span>
          </div>
          {!preview.data.newPlanActive && (
            <p className="text-red-600 dark:text-red-400">⚠ El plan destino está desactivado.</p>
          )}
          {preview.data.stripePriceMissing ? (
            <p className="text-red-600 dark:text-red-400">
              ⚠ Paga por Stripe y el plan nuevo no tiene precio en Stripe: configúralo en Planes
              antes de cambiarlo.
            </p>
          ) : preview.data.chargedByStripe ? (
            <p className="text-muted-foreground">
              Paga por Stripe: el cambio se aplica también allí y Stripe cobra o abona la diferencia
              en su próxima factura.
            </p>
          ) : null}
          {preview.data.extraUnits > 0 && (
            <p className="text-muted-foreground">
              Incluye {preview.data.extraUnits}{' '}
              {preview.data.extraUnits === 1 ? 'trastero de más' : 'trasteros de más'}, que se
              cobran con la cuota.
            </p>
          )}
          {preview.data.redundantAddons.length > 0 && (
            <p className="text-amber-600 dark:text-amber-400">
              ⚠ Se darán de baja (el plan nuevo los incluye o no los admite):{' '}
              {preview.data.redundantAddons.map((a) => a.name).join(', ')}. Se le avisa.
            </p>
          )}
          {preview.data.overLimits.length > 0 && (
            <p className="text-amber-600 dark:text-amber-400">
              ⚠ Uso por encima del plan nuevo:{' '}
              {preview.data.overLimits.map((l) => `${l.resource} ${l.used}/${l.limit}`).join(', ')}.
              El tenant conservará lo que tiene pero no podrá crear más.
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Controla qué módulos premium ve el tenant según su plan.
      </p>
    </div>
  );
}

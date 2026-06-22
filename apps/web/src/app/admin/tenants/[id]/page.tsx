'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AdminTenantActionSchema,
  type AdminTenantActionInput,
  ExtendTrialSchema,
  type ExtendTrialInput,
  ImpersonateSchema,
  type ImpersonateInput,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminSubscriptionPlans,
  useAdminTenant,
  useAnonymizeTenant,
  useChangePlan,
  useExtendTrial,
  useImpersonateTenant,
  useReactivateTenant,
  useSuspendTenant,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

/** Clave en localStorage para registrar la sesion de impersonacion activa. */
const IMPERSONATION_KEY = 'storageos:impersonation';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  trial: 'secondary',
  active: 'default',
  suspended: 'destructive',
  cancelled: 'outline',
};

export default function AdminTenantDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const tenant = useAdminTenant(id);

  const [dialog, setDialog] = useState<
    'suspend' | 'reactivate' | 'extendTrial' | 'impersonate' | 'anonymize' | null
  >(null);

  if (tenant.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!tenant.data) {
    return (
      <div className="px-4 py-4 sm:px-6 sm:py-6 text-sm text-muted-foreground">
        No hemos podido cargar el tenant.
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
            <Badge variant={STATUS_VARIANT[t.status] ?? 'secondary'}>{t.status}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">/{t.slug}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {t.status !== 'suspended' && (
            <Button variant="destructive" onClick={() => setDialog('suspend')}>
              Suspender
            </Button>
          )}
          {t.status === 'suspended' && (
            <Button onClick={() => setDialog('reactivate')}>Reactivar</Button>
          )}
          <Button variant="outline" onClick={() => setDialog('extendTrial')}>
            Extender trial
          </Button>
          <Button variant="outline" onClick={() => setDialog('impersonate')}>
            Impersonar
          </Button>
          <Button variant="destructive" onClick={() => setDialog('anonymize')}>
            Anonimizar (RGPD)
          </Button>
        </div>
      </div>

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
                <Row label="Estado" value={t.subscription.status} />
                <Row
                  label="Fin periodo"
                  value={
                    t.subscription.currentPeriodEnd
                      ? new Date(t.subscription.currentPeriodEnd).toLocaleDateString('es-ES')
                      : '—'
                  }
                />
                <Row
                  label="Stripe sub. ID"
                  value={t.subscription.stripeSubscriptionId ?? '—'}
                  mono
                />
                <ChangePlanControl tenantId={id} currentSlug={t.subscription.planSlug ?? null} />
              </>
            ) : (
              <p className="text-muted-foreground">Sin suscripción activa.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Uso</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <Stat label="Usuarios" value={t.userCount} />
            <Stat label="Inquilinos" value={t.customerCount} />
            <Stat label="Contratos" value={t.contractCount} />
          </CardContent>
        </Card>
      </div>

      <SuspendDialog open={dialog === 'suspend'} tenantId={t.id} onClose={() => setDialog(null)} />
      <ReactivateDialog
        open={dialog === 'reactivate'}
        tenantId={t.id}
        onClose={() => setDialog(null)}
      />
      <ExtendTrialDialog
        open={dialog === 'extendTrial'}
        tenantId={t.id}
        onClose={() => setDialog(null)}
      />
      <ImpersonateDialog
        open={dialog === 'impersonate'}
        tenantId={t.id}
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

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs' : ''}>{value}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
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
  onClose,
}: {
  open: boolean;
  tenantId: string;
  onClose: () => void;
}) {
  const suspend = useSuspendTenant();
  const form = useForm<AdminTenantActionInput>({
    resolver: zodResolver(AdminTenantActionSchema),
    defaultValues: { reason: '' },
  });

  async function onSubmit(values: AdminTenantActionInput) {
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
            Los usuarios no podrán iniciar sesión hasta que reactives la cuenta.
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
                    <Textarea {...field} rows={3} placeholder="Impago, abuso, ..." />
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
  onClose,
}: {
  open: boolean;
  tenantId: string;
  onClose: () => void;
}) {
  const reactivate = useReactivateTenant();
  const form = useForm<AdminTenantActionInput>({
    resolver: zodResolver(AdminTenantActionSchema),
    defaultValues: { reason: '' },
  });

  async function onSubmit(values: AdminTenantActionInput) {
    try {
      await reactivate.mutateAsync({ id: tenantId, input: values });
      toast.success('Tenant reactivado.');
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
          <DialogDescription>Los usuarios podrán volver a entrar.</DialogDescription>
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
  const form = useForm<ImpersonateInput>({
    resolver: zodResolver(ImpersonateSchema),
    defaultValues: { reason: '' },
  });

  async function onSubmit(values: ImpersonateInput) {
    try {
      const session = await impersonate.mutateAsync({ id: tenantId, input: values });
      // Guardamos la sesion de impersonacion en localStorage para que el panel
      // del tenant (a abrir en nueva pestaña) pueda detectarla. La consume
      // sera responsabilidad del modulo de auth del tenant (out of scope).
      if (typeof window !== 'undefined') {
        const expiresAt = Date.now() + session.expiresIn * 1000;
        window.localStorage.setItem(
          'storageos:impersonation',
          JSON.stringify({
            accessToken: session.accessToken,
            tenantName: session.tenantName,
            tenantSlug: session.tenantSlug,
            expiresAt,
          }),
        );
      }
      toast.success(`Impersonando ${session.tenantName} en nueva pestaña.`);
      window.open('/dashboard', '_blank', 'noopener');
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
          <DialogTitle>Impersonar tenant</DialogTitle>
          <DialogDescription>
            Se generará un token temporal con tu id de admin como auditoría. Úsalo solo para
            soporte.
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
                    <Textarea {...field} rows={3} placeholder="Investigación incidencia #1234" />
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
                Iniciar impersonación
              </Button>
            </DialogFooter>
          </form>
        </Form>
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
  const [confirmSlug, setConfirmSlug] = useState('');
  const form = useForm<AdminTenantActionInput>({
    resolver: zodResolver(AdminTenantActionSchema),
    defaultValues: { reason: '' },
  });

  const slugMatches = confirmSlug.trim() === tenantSlug;

  function close() {
    setConfirmSlug('');
    form.reset();
    onClose();
  }

  async function onSubmit(values: AdminTenantActionInput) {
    if (!slugMatches) return;
    try {
      const result = await anonymize.mutateAsync({ id: tenantId, input: values });
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
            tenant, se borran sus documentos y métodos de pago, se revocan las sesiones y la cuenta
            queda cancelada. Las facturas se conservan por obligación fiscal.
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
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={!slugMatches || form.formState.isSubmitting}
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

// Silenciar warning de variable no usada: la constante se exporta de forma
// implicita a traves del dialog; la mantenemos como documentacion.
void IMPERSONATION_KEY;

/** Selector inline para cambiar el plan de suscripción del tenant. */
function ChangePlanControl({
  tenantId,
  currentSlug,
}: {
  tenantId: string;
  currentSlug: string | null;
}) {
  const plans = useAdminSubscriptionPlans();
  const change = useChangePlan();
  const [slug, setSlug] = useState(currentSlug ?? '');
  const [reason, setReason] = useState('');

  async function submit() {
    if (!slug || slug === currentSlug) {
      toast.error('Elige un plan distinto al actual.');
      return;
    }
    if (reason.trim().length < 3) {
      toast.error('Indica un motivo.');
      return;
    }
    try {
      await change.mutateAsync({ id: tenantId, input: { planSlug: slug, reason: reason.trim() } });
      toast.success('Plan cambiado.');
      setReason('');
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
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
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
        <Button size="sm" onClick={submit} disabled={change.isPending}>
          Cambiar
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Controla qué módulos premium ve el tenant (free / starter / pro).
      </p>
    </div>
  );
}

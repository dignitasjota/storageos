'use client';

import { FEATURE_LABELS } from '@storageos/shared';
import { Check, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import {
  useCancelAddon,
  useChangePlan,
  useContractAddon,
  useCreateCheckoutSession,
  useCreatePortalSession,
  useSaasInvoicePdf,
  useSaasInvoices,
  useSaasPayments,
  useSaasSubscription,
  useSelfAddons,
  useSubscriptionPlans,
} from '@/lib/saas-billing/hooks';

/** Traduce el estado de la suscripción de Stripe a español. */
const STATUS_LABELS: Record<string, string> = {
  active: 'Activa',
  trialing: 'En prueba',
  incomplete: 'Incompleta',
  incomplete_expired: 'Caducada',
  past_due: 'Pago pendiente',
  canceled: 'Cancelada',
  unpaid: 'Impagada',
};
const statusLabel = (s: string) => STATUS_LABELS[s] ?? s;

/**
 * Pantalla de la suscripcion SaaS del propio tenant a StorageOS.
 * Solo accesible para owner (el backend ya lo aplica con `billing:configure`).
 *
 * - Trial: muestra plan actual + CTA "Suscribirse" → Stripe Checkout.
 * - Active con stripeCustomerId: CTA "Gestionar suscripción" → Stripe portal.
 */
export default function SaasBillingPage() {
  const subscription = useSaasSubscription();
  const plans = useSubscriptionPlans();
  const checkout = useCreateCheckoutSession();
  const portal = useCreatePortalSession();
  const changePlan = useChangePlan();
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(null);
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');

  if (subscription.isLoading) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!subscription.data) {
    return (
      <div className="text-sm text-muted-foreground">No hemos podido cargar tu suscripción.</div>
    );
  }

  const sub = subscription.data;
  const isTrialOrInactive = sub.status === 'trialing' || sub.status === 'incomplete';
  const canOpenPortal = sub.stripeCustomerId !== null;
  // Con suscripción Stripe viva puede cambiar de plan in-app; si no (pago
  // manual) el cambio lo gestiona soporte.
  const hasStripeSub = sub.stripeSubscriptionId !== null;

  function originUrl() {
    if (typeof window === 'undefined') return '';
    return window.location.origin;
  }

  async function onCheckout(planId: string) {
    setPendingPlanId(planId);
    try {
      const session = await checkout.mutateAsync({
        planId,
        billingCycle: cycle,
        successUrl: `${originUrl()}/settings/saas-billing?status=success`,
        cancelUrl: `${originUrl()}/settings/saas-billing?status=cancel`,
      });
      window.location.href = session.url;
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('Error iniciando el checkout.');
      setPendingPlanId(null);
    }
  }

  async function onPortal() {
    try {
      const session = await portal.mutateAsync({
        returnUrl: `${originUrl()}/settings/saas-billing`,
      });
      window.location.href = session.url;
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('Error abriendo el portal.');
    }
  }

  async function onChangePlan(planId: string) {
    setPendingPlanId(planId);
    try {
      await changePlan.mutateAsync({ planId, billingCycle: cycle });
      toast.success('Plan cambiado. Stripe ajustará la diferencia en tu próxima factura.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cambiar el plan.');
    } finally {
      setPendingPlanId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Suscripción a StorageOS</h1>
        <p className="text-sm text-muted-foreground">
          Gestiona el plan que tienes contratado con nosotros.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Plan actual</CardTitle>
          <Badge variant={sub.status === 'active' ? 'default' : 'secondary'}>
            {statusLabel(sub.status)}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Plan" value={sub.plan.name} />
          <Row
            label="Precio"
            value={sub.plan.priceMonthly.toLocaleString('es-ES', {
              style: 'currency',
              currency: sub.plan.currency,
            })}
          />
          <Row
            label="Periodo actual"
            value={`${new Date(sub.currentPeriodStart).toLocaleDateString(
              'es-ES',
            )} → ${new Date(sub.currentPeriodEnd).toLocaleDateString('es-ES')}`}
          />
          {sub.cancelAtPeriodEnd && (
            <p className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-900 dark:border-yellow-900/50 dark:bg-yellow-900/10 dark:text-yellow-200">
              Tu suscripción se cancelará al final del periodo actual.
            </p>
          )}

          <div className="pt-3">
            {canOpenPortal ? (
              <Button onClick={onPortal} disabled={portal.isPending}>
                {portal.isPending ? 'Abriendo portal...' : 'Gestionar suscripción'}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Aún no tienes método de pago. Elige un plan abajo para suscribirte.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-medium">Planes disponibles</h2>
          <p className="text-sm text-muted-foreground">
            {hasStripeSub
              ? 'Compara los planes y cambia cuando quieras. Al cambiar, Stripe ajusta la diferencia en tu próxima factura.'
              : 'Elige el plan que mejor se ajuste a tu operativa.'}
          </p>
        </div>

        <div className="inline-flex rounded-lg border p-1 text-sm">
          <button
            type="button"
            onClick={() => setCycle('monthly')}
            className={`rounded-md px-3 py-1 ${cycle === 'monthly' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
          >
            Mensual
          </button>
          <button
            type="button"
            onClick={() => setCycle('yearly')}
            className={`rounded-md px-3 py-1 ${cycle === 'yearly' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
          >
            Anual
          </button>
        </div>

        {plans.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {(plans.data ?? [])
              .filter((p) => p.isActive)
              .map((p) => {
                const pending = pendingPlanId === p.id;
                const isCurrent = sub.plan.id === p.id;
                return (
                  <Card key={p.id} className={isCurrent ? 'border-primary' : undefined}>
                    <CardHeader>
                      <div className="flex items-center justify-between gap-2">
                        <CardTitle className="text-base">{p.name}</CardTitle>
                        {isCurrent && <Badge>Tu plan</Badge>}
                      </div>
                      {p.description && (
                        <p className="text-xs text-muted-foreground">{p.description}</p>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {cycle === 'yearly' ? (
                        <div>
                          <div className="text-2xl font-semibold">
                            {p.priceYearly.toLocaleString('es-ES', {
                              style: 'currency',
                              currency: p.currency,
                            })}
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              /año
                            </span>
                          </div>
                          {p.priceMonthly > 0 && p.priceYearly < p.priceMonthly * 12 && (
                            <p className="text-xs font-medium text-green-600 dark:text-green-400">
                              Ahorras{' '}
                              {Math.round((1 - p.priceYearly / (p.priceMonthly * 12)) * 100)}% vs
                              mensual
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="text-2xl font-semibold">
                          {p.priceMonthly.toLocaleString('es-ES', {
                            style: 'currency',
                            currency: p.currency,
                          })}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            /mes
                          </span>
                        </div>
                      )}

                      {p.tenantFeatures.length > 0 ? (
                        <ul className="space-y-1 text-xs text-muted-foreground">
                          {p.tenantFeatures.map((f) => (
                            <li key={f} className="flex items-center gap-1.5">
                              <Check className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />
                              {FEATURE_LABELS[f] ?? f}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">Funciones básicas.</p>
                      )}

                      <PlanCta
                        isCurrent={isCurrent}
                        hasStripePrice={
                          cycle === 'yearly'
                            ? p.stripePriceIdYearly !== null
                            : p.stripePriceId !== null
                        }
                        pending={pending}
                        mode={isTrialOrInactive ? 'subscribe' : hasStripeSub ? 'change' : 'manual'}
                        onSubscribe={() => onCheckout(p.id)}
                        onChange={() => onChangePlan(p.id)}
                      />
                    </CardContent>
                  </Card>
                );
              })}
          </div>
        )}
      </section>

      <SelfAddonsSection />
      <SaasInvoicesSection />
    </div>
  );
}

/** Botón de un plan según el estado del tenant. */
function PlanCta({
  isCurrent,
  hasStripePrice,
  pending,
  mode,
  onSubscribe,
  onChange,
}: {
  isCurrent: boolean;
  hasStripePrice: boolean;
  pending: boolean;
  mode: 'subscribe' | 'change' | 'manual';
  onSubscribe: () => void;
  onChange: () => void;
}) {
  if (isCurrent) {
    return (
      <Button className="w-full" variant="outline" disabled>
        Plan actual
      </Button>
    );
  }
  if (!hasStripePrice) {
    return (
      <Button className="w-full" variant="outline" disabled>
        Próximamente
      </Button>
    );
  }
  if (mode === 'manual') {
    // Suscripción de pago manual: el cambio lo gestiona soporte.
    return (
      <Button asChild className="w-full" variant="outline">
        <Link href="/support">Contactar con soporte</Link>
      </Button>
    );
  }
  return (
    <Button
      className="w-full"
      disabled={pending}
      onClick={mode === 'subscribe' ? onSubscribe : onChange}
    >
      {pending
        ? 'Procesando...'
        : mode === 'subscribe'
          ? 'Suscribirse ahora'
          : 'Cambiar a este plan'}
    </Button>
  );
}

function SaasInvoicesSection() {
  const invoices = useSaasInvoices();
  const payments = useSaasPayments();
  const pdf = useSaasInvoicePdf();

  const eur = (n: number, currency = 'EUR') =>
    new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(n);
  const date = (s: string | null) => (s ? new Date(s).toLocaleDateString('es-ES') : '—');

  async function openPdf(invoiceId: string) {
    try {
      const { url } = await pdf.mutateAsync(invoiceId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo abrir el PDF.');
    }
  }

  const inv = invoices.data ?? [];
  const pays = payments.data ?? [];

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Facturas y pagos</h2>
        <p className="text-sm text-muted-foreground">
          Las facturas que StorageOS te emite por tu suscripción y tu historial de pagos. (No
          confundir con las facturas que tú emites a tus inquilinos, en Ajustes → Facturación.)
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Tus facturas</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.isLoading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : inv.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no tienes facturas.</p>
          ) : (
            <ul className="divide-y">
              {inv.map((f) => (
                <li key={f.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <span className="font-medium">{f.fullNumber}</span>
                      <span className="ml-2 text-muted-foreground">{date(f.issuedAt)}</span>
                      {f.lines.length <= 1 && f.concept && (
                        <div className="text-xs text-muted-foreground">{f.concept}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span>{eur(Number(f.total), f.currency)}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openPdf(f.id)}
                        disabled={pdf.isPending}
                      >
                        PDF
                      </Button>
                    </div>
                  </div>
                  {f.lines.length > 1 && (
                    <ul className="mt-1 space-y-0.5 border-l pl-3 text-xs text-muted-foreground">
                      {f.lines.map((l) => (
                        <li key={l.id} className="flex justify-between gap-2">
                          <span>
                            {l.description}
                            {l.quantity > 1 && ` ×${l.quantity}`}
                          </span>
                          <span className="tabular-nums">{eur(Number(l.total), f.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Historial de pagos</CardTitle>
        </CardHeader>
        <CardContent>
          {payments.isLoading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : pays.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay pagos registrados.</p>
          ) : (
            <ul className="divide-y">
              {pays.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div>
                    <span>{date(p.paidAt)}</span>
                    <span className="ml-2 text-muted-foreground">{p.planName ?? p.provider}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span>{eur(Number(p.amount), p.currency)}</span>
                    <Badge variant={p.status === 'paid' ? 'secondary' : 'outline'}>
                      {p.status}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function SelfAddonsSection() {
  const data = useSelfAddons();
  const contract = useContractAddon();
  const cancel = useCancelAddon();

  async function doContract(addonId: string) {
    try {
      await contract.mutateAsync({ addonId, quantity: 1 });
      toast.success('Extra contratado. Se añadirá a tu próxima factura.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo contratar.');
    }
  }
  async function doCancel(assignmentId: string) {
    try {
      await cancel.mutateAsync(assignmentId);
      toast.success('Extra cancelado.');
    } catch {
      toast.error('No se pudo cancelar.');
    }
  }

  const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
  const owned = data.data?.summary.addons ?? [];
  const available = data.data?.available ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Extras de tu cuenta</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            {owned.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Contratados</p>
                {owned.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                  >
                    <span className="font-medium">{a.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{eur(a.lineTotal)}/mes</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => doCancel(a.id)}
                        disabled={cancel.isPending}
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                ))}
                <div className="flex justify-between border-t pt-2 text-sm font-semibold">
                  <span>Total mensual (plan + extras)</span>
                  <span>{eur(data.data?.summary.effectiveMonthly ?? 0)}</span>
                </div>
              </div>
            )}

            {available.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Disponibles</p>
                {available.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                  >
                    <div>
                      <span className="font-medium">{a.name}</span>
                      {a.description && (
                        <p className="text-xs text-muted-foreground">{a.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{eur(a.priceMonthly)}/mes</span>
                      <Button
                        size="sm"
                        onClick={() => doContract(a.id)}
                        disabled={contract.isPending}
                      >
                        Contratar
                      </Button>
                    </div>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Los extras se facturan con tu suscripción. Al contratarlos se activan al instante.
                </p>
              </div>
            )}

            {owned.length === 0 && available.length === 0 && (
              <p className="text-sm text-muted-foreground">No hay extras disponibles.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

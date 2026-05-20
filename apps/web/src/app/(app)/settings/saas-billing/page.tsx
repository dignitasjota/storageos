'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import {
  useCreateCheckoutSession,
  useCreatePortalSession,
  useSaasSubscription,
  useSubscriptionPlans,
} from '@/lib/saas-billing/hooks';

/**
 * Pantalla de la suscripcion SaaS del propio tenant a StorageOS.
 * Solo accesible para owner (el backend ya lo aplica con RolesGuard).
 *
 * - Trial: muestra plan actual + CTA "Suscribirse" → Stripe Checkout.
 * - Active con stripeCustomerId: CTA "Gestionar suscripción" → Stripe portal.
 */
export default function SaasBillingPage() {
  const subscription = useSaasSubscription();
  const plans = useSubscriptionPlans();
  const checkout = useCreateCheckoutSession();
  const portal = useCreatePortalSession();
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(null);

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

  function originUrl() {
    if (typeof window === 'undefined') return '';
    return window.location.origin;
  }

  async function onCheckout(planId: string) {
    setPendingPlanId(planId);
    try {
      const session = await checkout.mutateAsync({
        planId,
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
          <Badge variant={sub.status === 'active' ? 'default' : 'secondary'}>{sub.status}</Badge>
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

      {isTrialOrInactive && (
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-medium">Planes disponibles</h2>
            <p className="text-sm text-muted-foreground">
              Elige el plan que mejor se ajuste a tu operativa.
            </p>
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
                    <Card key={p.id}>
                      <CardHeader>
                        <CardTitle className="text-base">{p.name}</CardTitle>
                        {p.description && (
                          <p className="text-xs text-muted-foreground">{p.description}</p>
                        )}
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="text-2xl font-semibold">
                          {p.priceMonthly.toLocaleString('es-ES', {
                            style: 'currency',
                            currency: p.currency,
                          })}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            /mes
                          </span>
                        </div>
                        <Button
                          className="w-full"
                          disabled={pending || !p.stripePriceId}
                          variant={isCurrent ? 'outline' : 'default'}
                          onClick={() => onCheckout(p.id)}
                        >
                          {pending
                            ? 'Iniciando...'
                            : isCurrent
                              ? 'Continuar con este plan'
                              : 'Suscribirse ahora'}
                        </Button>
                        {!p.stripePriceId && (
                          <p className="text-xs text-muted-foreground">Próximamente.</p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
            </div>
          )}
        </section>
      )}
    </div>
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

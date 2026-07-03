'use client';

import { FEATURE_LABELS, type TenantFeature } from '@storageos/shared';
import { Lock, Sparkles } from 'lucide-react';
import Link from 'next/link';

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useBillingStatus, useFeatures, useMe } from '@/lib/auth/hooks';

/**
 * Gatea una página por **feature del plan del tenant**. Si el plan no la
 * incluye, muestra un upsell ("No disponible en tu plan") en vez del contenido.
 * Cosmético: la frontera real (cuando exista) la pone el backend.
 */
export function FeatureGate({
  feature,
  children,
}: {
  feature: TenantFeature;
  children: ReactNode;
}) {
  const me = useMe();
  const features = useFeatures();
  const billing = useBillingStatus();

  if (me.isLoading || !me.data) return null;
  if (features.includes(feature)) return <>{children}</>;

  // ¿La feature está suspendida por impago de un add-on? (mensaje específico)
  const suspendedByPayment = billing.data?.suspendedFeatures.includes(feature) ?? false;

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <Card className="max-w-md text-center">
        <CardContent className="flex flex-col items-center gap-4 p-8">
          <span
            className={
              suspendedByPayment
                ? 'flex size-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-600 dark:text-red-400'
                : 'flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary'
            }
          >
            <Lock className="size-6" />
          </span>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold tracking-tight">
              {suspendedByPayment
                ? `${FEATURE_LABELS[feature]} está suspendida`
                : `${FEATURE_LABELS[feature]} no está en tu plan`}
            </h2>
            <p className="text-sm text-muted-foreground">
              {suspendedByPayment
                ? 'Esta funcionalidad está suspendida por un pago pendiente. Regulariza el pago para reactivarla.'
                : 'Este módulo está disponible en un plan superior. Mejora tu plan para desbloquearlo.'}
            </p>
          </div>
          <Button asChild variant={suspendedByPayment ? 'destructive' : 'default'}>
            <Link href={suspendedByPayment ? '/support' : '/settings/saas-billing'}>
              <Sparkles className="mr-1 h-4 w-4" />{' '}
              {suspendedByPayment ? 'Contactar para regularizar' : 'Ver planes'}
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

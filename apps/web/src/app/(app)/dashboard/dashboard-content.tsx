'use client';

import { Sparkles } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { DashboardMetrics } from './dashboard-metrics';
import { MobileHome } from './mobile-home';
import { NextStepCard } from './next-step-card';
import { OwnOccupancyCard } from './occupancy-card';
import { OnboardingCard } from './onboarding-card';
import { QuickActions } from './quick-actions';

import { useOnboarding } from '@/components/onboarding/onboarding-steps';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/use-mobile';
import { useHasPermission, useMe } from '@/lib/auth/hooks';

const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  trial: 'En prueba',
  active: 'Activa',
  past_due: 'Pago pendiente',
  cancelled: 'Cancelada',
  expired: 'Caducada',
};

export function DashboardContent() {
  const t = useTranslations('dashboard');
  const format = useFormatter();
  const me = useMe();
  const canSeeAnalytics = useHasPermission('analytics:read');
  const canSeeUnits = useHasPermission('units:read');
  const isMobile = useIsMobile();
  const onboarding = useOnboarding();
  // Hasta el primer contrato las cifras salen todas a cero: no se enseñan.
  const hasFirstContract = onboarding.data?.steps.find((s) => s.key === 'contract')?.done ?? true;

  // En móvil, un «home tipo app» con acciones grandes en vez del dashboard de
  // métricas (más ágil para operar desde el local).
  if (isMobile) return <MobileHome />;

  if (me.isLoading || !me.data) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-4 w-96" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
      </div>
    );
  }

  const { user, tenant, subscription } = me.data;
  const trialDate = tenant.trialEndsAt ? new Date(tenant.trialEndsAt) : null;
  const planTitle =
    subscription.planName ??
    subscription.planSlug.charAt(0).toUpperCase() + subscription.planSlug.slice(1);

  return (
    <div className="space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('welcome', { name: user.fullName })}
          </h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Plan {planTitle}</Badge>
          {tenant.status === 'trial' && trialDate ? (
            <Badge variant="outline" className="gap-1 border-primary/30 text-primary">
              <Sparkles className="size-3" />
              {t('cards.trial.endsOn', { date: format.dateTime(trialDate, 'long') })}
            </Badge>
          ) : (
            <Badge variant="outline">
              {SUBSCRIPTION_STATUS_LABELS[subscription.status] ?? subscription.status}
            </Badge>
          )}
        </div>
      </header>

      <OnboardingCard />
      <NextStepCard />

      <QuickActions />

      {canSeeAnalytics && !hasFirstContract ? (
        <Card className="border-dashed">
          <CardContent className="py-6 text-sm text-muted-foreground">
            Aquí verás tus ingresos, la ocupación, la morosidad y las previsiones en cuanto tengas
            tu primer contrato.
          </CardContent>
        </Card>
      ) : canSeeAnalytics ? (
        <DashboardMetrics />
      ) : (
        <>
          {canSeeUnits && <OwnOccupancyCard />}
          <Card className="border-dashed">
            <CardContent className="py-6 text-sm text-muted-foreground">
              Tu rol no tiene acceso a las métricas de negocio. Pide a un administrador el permiso{' '}
              <span className="font-mono">analytics:read</span> para ver ingresos, ocupación y
              previsiones.
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

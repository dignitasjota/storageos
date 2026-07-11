'use client';

import { Sparkles } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { AgingCard } from './aging-card';
import { ChurnRiskCard } from './churn-risk-card';
import { FacilityOccupancyCard } from './facility-occupancy-card';
import { ForecastCard } from './forecast-card';
import { KpiTiles } from './kpi-tiles';
import { LeadsCard } from './leads-card';
import { MobileHome } from './mobile-home';
import { OccupancyCard } from './occupancy-card';
import { OnboardingCard } from './onboarding-card';
import { QuickActions } from './quick-actions';
import { RevenueTrendCard } from './revenue-trend-card';
import { SuggestedActionsCard } from './suggested-actions-card';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/use-mobile';
import { useHasPermission, useMe } from '@/lib/auth/hooks';

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export function DashboardContent() {
  const t = useTranslations('dashboard');
  const format = useFormatter();
  const me = useMe();
  const canSeeAnalytics = useHasPermission('analytics:read');
  const isMobile = useIsMobile();

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
  const days = daysUntil(tenant.trialEndsAt);
  const trialDate = tenant.trialEndsAt ? new Date(tenant.trialEndsAt) : null;
  const planTitle = subscription.planSlug.charAt(0).toUpperCase() + subscription.planSlug.slice(1);

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
          <Badge variant="secondary" className="capitalize">
            Plan {planTitle}
          </Badge>
          {tenant.status === 'trial' && days !== null ? (
            <Badge variant="outline" className="gap-1 border-primary/30 text-primary">
              <Sparkles className="size-3" />
              {t('cards.trial.remaining', { days })}
              {trialDate ? ` · ${format.dateTime(trialDate, 'long')}` : ''}
            </Badge>
          ) : (
            <Badge variant="outline" className="capitalize">
              {subscription.status}
            </Badge>
          )}
        </div>
      </header>

      <OnboardingCard />

      <QuickActions />

      {canSeeAnalytics ? (
        <>
          <SuggestedActionsCard />

          <KpiTiles />

          <div className="grid gap-4 lg:grid-cols-2">
            <RevenueTrendCard />
            <OccupancyCard />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ForecastCard />
            <AgingCard />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChurnRiskCard />
            <LeadsCard />
          </div>

          <FacilityOccupancyCard />
        </>
      ) : (
        <>
          <OccupancyCard />
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

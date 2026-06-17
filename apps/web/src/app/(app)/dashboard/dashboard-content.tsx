'use client';

import { Calendar, CreditCard, Sparkles } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { BillingMetricsCard } from './billing-metrics-card';
import { CustomersKpiCard } from './customers-kpi-card';
import { OccupancyCard } from './occupancy-card';
import { RevenueKpiCard } from './revenue-kpi-card';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/lib/auth/hooks';

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export function DashboardContent() {
  const t = useTranslations('dashboard');
  const format = useFormatter();
  const me = useMe();

  if (me.isLoading || !me.data) {
    return (
      <div className="container py-10">
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="mb-8 h-4 w-96" />
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  const { user, tenant, subscription } = me.data;
  const days = daysUntil(tenant.trialEndsAt);
  const trialDate = tenant.trialEndsAt ? new Date(tenant.trialEndsAt) : null;
  const planTitle = subscription.planSlug.charAt(0).toUpperCase() + subscription.planSlug.slice(1);

  return (
    <div className="container space-y-8 py-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('welcome', { name: user.fullName })}
        </h1>
        <p className="text-muted-foreground">{t('subtitle')}</p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        {tenant.status === 'trial' ? (
          <Card>
            <CardHeader>
              <Sparkles className="size-5 text-primary" aria-hidden />
              <CardTitle className="mt-2 text-base">{t('cards.trial.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-2xl font-semibold">
                {days !== null ? t('cards.trial.remaining', { days }) : '—'}
              </p>
              {trialDate ? (
                <p className="text-xs text-muted-foreground">
                  {t('cards.trial.endsOn', { date: format.dateTime(trialDate, 'long') })}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CreditCard className="size-5 text-primary" aria-hidden />
            <CardTitle className="mt-2 text-base">{t('cards.plan.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{t('cards.plan.current', { plan: planTitle })}</p>
            <Badge variant="secondary" className="mt-2 capitalize">
              {subscription.status}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Calendar className="size-5 text-primary" aria-hidden />
            <CardTitle className="mt-2 text-base">{t('cards.tenant.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-semibold">{tenant.name}</p>
            <p className="text-xs text-muted-foreground">
              {t('cards.tenant.slug', { slug: tenant.slug })}
            </p>
          </CardContent>
        </Card>
      </section>

      <BillingMetricsCard />

      <CustomersKpiCard />

      <RevenueKpiCard />

      <OccupancyCard />
    </div>
  );
}

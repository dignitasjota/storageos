'use client';

import { Building2, CalendarClock, CreditCard, Sparkles } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { BillingMetricsCard } from './billing-metrics-card';
import { CustomersKpiCard } from './customers-kpi-card';
import { OccupancyCard } from './occupancy-card';
import { RevenueKpiCard } from './revenue-kpi-card';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/lib/auth/hooks';

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/** Tarjeta de KPI/cuenta con icono en círculo tintado (estilo minimalista). */
function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  badge,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  badge?: React.ReactNode;
}) {
  return (
    <Card className="transition-shadow hover:shadow-soft">
      <CardContent className="flex items-start gap-4 p-5">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="truncate text-xl font-semibold tracking-tight">{value}</p>
          {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}
          {badge}
        </div>
      </CardContent>
    </Card>
  );
}

export function DashboardContent() {
  const t = useTranslations('dashboard');
  const format = useFormatter();
  const me = useMe();

  if (me.isLoading || !me.data) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-4 w-96" />
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
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
    <div className="space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t('welcome', { name: user.fullName })}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        {tenant.status === 'trial' ? (
          <StatCard
            icon={Sparkles}
            label={t('cards.trial.title')}
            value={days !== null ? t('cards.trial.remaining', { days }) : '—'}
            hint={
              trialDate
                ? t('cards.trial.endsOn', { date: format.dateTime(trialDate, 'long') })
                : undefined
            }
          />
        ) : null}

        <StatCard
          icon={CreditCard}
          label={t('cards.plan.title')}
          value={t('cards.plan.current', { plan: planTitle })}
          badge={
            <Badge variant="secondary" className="mt-1 capitalize">
              {subscription.status}
            </Badge>
          }
        />

        <StatCard
          icon={tenant.status === 'trial' ? Building2 : CalendarClock}
          label={t('cards.tenant.title')}
          value={tenant.name}
          hint={t('cards.tenant.slug', { slug: tenant.slug })}
        />
      </section>

      <BillingMetricsCard />
      <CustomersKpiCard />
      <RevenueKpiCard />
      <OccupancyCard />
    </div>
  );
}

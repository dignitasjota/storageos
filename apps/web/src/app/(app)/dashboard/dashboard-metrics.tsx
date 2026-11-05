'use client';

import { AgingCard } from './aging-card';
import { ChurnRiskCard } from './churn-risk-card';
import { CollectionsSummaryCard } from './collections-summary-card';
import { FacilityOccupancyCard } from './facility-occupancy-card';
import { ForecastCard } from './forecast-card';
import { KpiTiles } from './kpi-tiles';
import { LeadsCard } from './leads-card';
import { OccupancyCard } from './occupancy-card';
import { RevenueTrendCard } from './revenue-trend-card';
import { SeoNudgeCard } from './seo-nudge-card';
import { SuggestedActionsCard } from './suggested-actions-card';

import { MonthStrip } from '@/components/dashboard/month-strip';
import { SectionError } from '@/components/dashboard/section-state';
import { Card, CardContent } from '@/components/ui/card';
import { useHasFeature } from '@/lib/auth/hooks';
import { useDashboardOverview } from '@/lib/dashboard/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';

/** Las cifras del Resumen: una sola petición, repartida entre sus tarjetas. */
export function DashboardMetrics() {
  const hasLocalSeo = useHasFeature('local_seo');
  const q = useDashboardOverview(useHeaderFacilityId());
  const d = q.data;
  const section = { loading: q.isLoading, onRetry: () => void q.refetch() };
  const occupancy = d?.occupancy;

  return (
    <>
      <SuggestedActionsCard />

      {hasLocalSeo && <SeoNudgeCard />}

      <KpiTiles data={d} loading={q.isLoading} />

      {!q.isLoading && !d?.month ? (
        <Card>
          <CardContent>
            <SectionError onRetry={section.onRetry} />
          </CardContent>
        </Card>
      ) : (
        <MonthStrip kpis={d?.month ?? undefined} hideOccupancy />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <RevenueTrendCard data={d?.monthlyRevenue} {...section} />
        <OccupancyCard
          data={
            occupancy ? { totalUnits: occupancy.totalUnits, byStatus: occupancy.byStatus } : null
          }
          {...section}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ForecastCard data={d?.forecast} {...section} />
        <AgingCard data={d?.receivables} {...section} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChurnRiskCard data={d?.churnRisk} {...section} />
        <LeadsCard data={d?.leads} {...section} />
      </div>

      <CollectionsSummaryCard />

      <FacilityOccupancyCard data={occupancy} {...section} />
    </>
  );
}

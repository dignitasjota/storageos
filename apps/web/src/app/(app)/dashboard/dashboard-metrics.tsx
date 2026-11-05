'use client';

import {
  DASHBOARD_CARDS,
  DASHBOARD_PERIOD_LABELS,
  DashboardPeriodEnum,
  resolveDashboardLayout,
  type DashboardCardId,
  type DashboardPeriod,
} from '@storageos/shared';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { AgingCard } from './aging-card';
import { CashCard } from './cash-card';
import { ChurnRiskCard } from './churn-risk-card';
import { CollectionsSummaryCard } from './collections-summary-card';
import { CommercialCard } from './commercial-card';
import { CustomizeDialog } from './customize-dialog';
import { FacilitiesCard } from './facilities-card';
import { ForecastCard } from './forecast-card';
import { KpiTiles } from './kpi-tiles';
import { LeadsCard } from './leads-card';
import { MovesCard } from './moves-card';
import { OccupancyCard } from './occupancy-card';
import { PeriodStrip } from './period-strip';
import { ResultCard } from './result-card';
import { RevenueTrendCard } from './revenue-trend-card';
import { SeoNudgeCard } from './seo-nudge-card';
import { SuggestedActionsCard } from './suggested-actions-card';
import { VacancyCard } from './vacancy-card';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useDashboardLayout, useDashboardOverview } from '@/lib/dashboard/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';

const PERIOD_KEY = 'storageos.dashboard.period';
const WIDE = new Set<DashboardCardId>(DASHBOARD_CARDS.filter((c) => c.wide).map((c) => c.id));

/** Las cifras del Resumen: una sola petición, repartida entre sus tarjetas. */
export function DashboardMetrics() {
  const hasLocalSeo = useHasFeature('local_seo');
  const hasCollections = useHasFeature('collections');
  const canSeeExpenses = useHasPermission('expenses:read');
  const canSeeContracts = useHasPermission('contracts:read');
  const [period, setPeriod] = useState<DashboardPeriod>('month');
  const [customizing, setCustomizing] = useState(false);

  useEffect(() => {
    try {
      const saved = DashboardPeriodEnum.safeParse(localStorage.getItem(PERIOD_KEY));
      if (saved.success) setPeriod(saved.data);
    } catch {
      // Sin almacenamiento se queda el mes en curso.
    }
  }, []);

  function changePeriod(next: DashboardPeriod) {
    setPeriod(next);
    try {
      localStorage.setItem(PERIOD_KEY, next);
    } catch {
      // Solo es una comodidad: no pasa nada si no se guarda.
    }
  }

  const q = useDashboardOverview(useHeaderFacilityId(), period);
  const savedLayout = useDashboardLayout();
  const layout = savedLayout.data ?? resolveDashboardLayout({});
  const d = q.data;
  const section = { loading: q.isLoading, onRetry: () => void q.refetch() };
  const occupancy = d?.occupancy;

  const available = (id: DashboardCardId) => {
    if (id === 'seo') return hasLocalSeo;
    if (id === 'collections') return hasCollections;
    if (id === 'result') return canSeeExpenses;
    if (id === 'moves') return canSeeContracts;
    return true;
  };

  const cards: Record<DashboardCardId, ReactNode> = {
    suggestions: <SuggestedActionsCard />,
    seo: <SeoNudgeCard />,
    kpis: <KpiTiles data={d} loading={q.isLoading} />,
    period: <PeriodStrip data={d?.period} {...section} />,
    cash: <CashCard data={d?.cash} {...section} />,
    result: <ResultCard data={d?.result} {...section} />,
    revenue: <RevenueTrendCard data={d?.monthlyRevenue} {...section} />,
    occupancy: (
      <OccupancyCard
        data={occupancy ? { totalUnits: occupancy.totalUnits, byStatus: occupancy.byStatus } : null}
        {...section}
      />
    ),
    vacancy: <VacancyCard data={d?.vacancy} {...section} />,
    moves: <MovesCard data={d?.moves} {...section} />,
    facilities: <FacilitiesCard data={d?.byFacility} {...section} />,
    commercial: <CommercialCard data={d?.commercial} {...section} />,
    leads: <LeadsCard data={d?.leads} {...section} />,
    forecast: <ForecastCard data={d?.forecast} {...section} />,
    aging: <AgingCard data={d?.receivables} {...section} />,
    churn: <ChurnRiskCard data={d?.churnRisk} {...section} />,
    collections: <CollectionsSummaryCard />,
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={period} onValueChange={(v) => changePeriod(v as DashboardPeriod)}>
          <SelectTrigger className="w-48" aria-label="Periodo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DashboardPeriodEnum.options.map((p) => (
              <SelectItem key={p} value={p}>
                {DASHBOARD_PERIOD_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" onClick={() => setCustomizing(true)}>
          <SlidersHorizontal className="mr-1 size-4" /> Personalizar
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {layout.order
          .filter((id) => available(id) && !layout.hidden.includes(id))
          .map((id) => (
            <div
              key={id}
              className={`min-w-0 empty:hidden [&>*]:h-full ${WIDE.has(id) ? 'lg:col-span-2' : ''}`}
            >
              {cards[id]}
            </div>
          ))}
      </div>

      <CustomizeDialog
        open={customizing}
        onOpenChange={setCustomizing}
        layout={layout}
        available={available}
      />
    </>
  );
}

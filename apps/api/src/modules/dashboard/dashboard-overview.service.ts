import { Injectable, Logger } from '@nestjs/common';

import { todayInTimezone } from '../../common/format';
import { resolveAnalyticsScope } from '../analytics/analytics-scope';
import { AnalyticsService } from '../analytics/analytics.service';
import { receivables, tenantTimezone } from '../analytics/business-metrics';
import { InsightsService } from '../analytics/insights.service';
import { PrismaService } from '../database/prisma.service';

import { TodaySummaryService } from './today-summary.service';

import type { DashboardOverviewDto, Permission } from '@storageos/shared';

/** Cifras del Resumen: una petición, con cada sección independiente de las demás. */
@Injectable()
export class DashboardOverviewService {
  private readonly logger = new Logger(DashboardOverviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly insights: InsightsService,
    private readonly summary: TodaySummaryService,
  ) {}

  async overview(
    tenantId: string,
    facilityId: string | undefined,
    userScope: string[] | null,
    permissions: readonly Permission[],
  ): Promise<DashboardOverviewDto> {
    const scope = resolveAnalyticsScope(userScope, facilityId);
    const section = async <T>(name: string, load: () => Promise<T>): Promise<T | null> => {
      try {
        return await load();
      } catch (err) {
        this.logger.error(`Resumen: falló «${name}» del tenant ${tenantId}: ${String(err)}`);
        return null;
      }
    };

    const [month, revenue, occupancy, customers, debt, monthlyRevenue, forecast, churnRisk, leads] =
      await Promise.all([
        section('month', () => this.summary.kpis(tenantId, facilityId, userScope, permissions)),
        section('revenue', () => this.analytics.getRevenue(tenantId, scope)),
        section('occupancy', () => this.analytics.getOccupancy(tenantId, scope)),
        section('customers', () => this.analytics.getCustomerStats(tenantId, scope)),
        section('receivables', () =>
          this.prisma.withTenant(
            async (tx) =>
              receivables(tx, scope, todayInTimezone(await tenantTimezone(tx, tenantId))),
            tenantId,
          ),
        ),
        section('monthlyRevenue', () =>
          this.analytics.getMonthlyRevenue(tenantId, { months: 12 }, scope),
        ),
        section('forecast', () => this.insights.getRevenueForecast(tenantId, { months: 6 }, scope)),
        section('churnRisk', () => this.insights.getChurnRisk(tenantId, scope)),
        section('leads', () => this.analytics.getLeadsFunnel(tenantId, undefined, scope)),
      ]);

    return {
      month,
      revenue,
      occupancy,
      customers,
      receivables: debt,
      monthlyRevenue,
      forecast,
      churnRisk,
      leads,
    };
  }
}

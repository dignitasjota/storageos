import { Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { AnalyticsService } from './analytics.service';
import { InsightsService } from './insights.service';

import type {
  AgingKpiDto,
  ChurnKpiDto,
  ChurnRiskKpiDto,
  CustomerStatsKpiDto,
  LeadsFunnelKpiDto,
  OccupancyKpiDto,
  PricingSuggestionsDto,
  RevenueKpiDto,
} from '@storageos/shared';

@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly service: AnalyticsService,
    private readonly insights: InsightsService,
  ) {}

  @Get('occupancy')
  getOccupancy(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<OccupancyKpiDto> {
    return this.service.getOccupancy(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
    });
  }

  @Get('customers')
  getCustomerStats(@CurrentUser() user: AuthenticatedUser): Promise<CustomerStatsKpiDto> {
    return this.service.getCustomerStats(user.tenantId);
  }

  @Get('revenue')
  getRevenue(@CurrentUser() user: AuthenticatedUser): Promise<RevenueKpiDto> {
    return this.service.getRevenue(user.tenantId);
  }

  @Get('churn')
  getChurn(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ChurnKpiDto> {
    return this.service.getChurn(user.tenantId, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }

  @Get('aging')
  getAging(
    @CurrentUser() user: AuthenticatedUser,
    @Query('atDate') atDate?: string,
  ): Promise<AgingKpiDto> {
    return this.service.getAging(user.tenantId, atDate);
  }

  @Get('leads-funnel')
  getLeadsFunnel(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<LeadsFunnelKpiDto> {
    return this.service.getLeadsFunnel(user.tenantId, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }

  @Get('churn-risk')
  getChurnRisk(@CurrentUser() user: AuthenticatedUser): Promise<ChurnRiskKpiDto> {
    return this.insights.getChurnRisk(user.tenantId);
  }

  @Get('pricing-suggestions')
  getPricingSuggestions(@CurrentUser() user: AuthenticatedUser): Promise<PricingSuggestionsDto> {
    return this.insights.getPricingSuggestions(user.tenantId);
  }
}

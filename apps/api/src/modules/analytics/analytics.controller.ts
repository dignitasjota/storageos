import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ApplyPricingSchema, ApplyUnitPricingSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AnalyticsService } from './analytics.service';
import { BenchmarkService } from './benchmark.service';
import { InsightsService } from './insights.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  AgingKpiDto,
  ApplyPricingResultDto,
  ApplyUnitPricingResultDto,
  BenchmarkDto,
  ChurnKpiDto,
  ChurnRiskKpiDto,
  CustomerStatsKpiDto,
  LeadsFunnelKpiDto,
  LeadsUtmKpiDto,
  MonthlyRevenueKpiDto,
  OccupancyKpiDto,
  PricingSuggestionsDto,
  RevenueForecastDto,
  RevenueKpiDto,
  UnitPricingSuggestionsDto,
} from '@storageos/shared';
import type { Request } from 'express';

class ApplyPricingDto extends createZodDto(ApplyPricingSchema) {}
class ApplyUnitPricingDto extends createZodDto(ApplyUnitPricingSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@RequirePermission('analytics:read')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly service: AnalyticsService,
    private readonly insights: InsightsService,
    private readonly benchmark: BenchmarkService,
  ) {}

  /** Comparativa anónima del tenant frente al sector (ocupación / precio / €m²). */
  @Get('benchmark')
  getBenchmark(@CurrentUser() user: AuthenticatedUser): Promise<BenchmarkDto> {
    return this.benchmark.getBenchmark(user.tenantId);
  }

  @Get('occupancy')
  getOccupancy(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<OccupancyKpiDto> {
    return this.service.getOccupancy(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
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

  @Get('monthly-revenue')
  getMonthlyRevenue(
    @CurrentUser() user: AuthenticatedUser,
    @Query('months') months?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<MonthlyRevenueKpiDto> {
    const parsed = months ? Number.parseInt(months, 10) : undefined;
    return this.service.getMonthlyRevenue(user.tenantId, {
      ...(parsed && Number.isFinite(parsed) ? { months: parsed } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
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

  @Get('leads-utm')
  getLeadsUtm(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<LeadsUtmKpiDto> {
    return this.service.getLeadsUtm(user.tenantId, {
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

  /** Aplica el precio sugerido al tipo de trastero (yield management). */
  @RequirePermission('units:manage')
  @Post('pricing-suggestions/apply')
  applyPricing(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ApplyPricingDto,
    @Req() req: Request,
  ): Promise<ApplyPricingResultDto> {
    return this.insights.applyPricing({
      tenantId: user.tenantId,
      userId: user.sub,
      unitTypeId: body.unitTypeId,
      price: body.price,
      meta: extractMeta(req),
    });
  }

  /** Sugerencia de precio por trastero individual (ocupación + días vacío + competencia opcional). */
  @Get('unit-pricing-suggestions')
  getUnitPricingSuggestions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('includeCompetition') includeCompetition?: string,
  ): Promise<UnitPricingSuggestionsDto> {
    return this.insights.getUnitPricingSuggestions(
      user.tenantId,
      facilityId?.trim() || undefined,
      includeCompetition === 'true',
    );
  }

  /** Aplica el precio sugerido a un trastero (fija su basePriceMonthly). */
  @RequirePermission('units:manage')
  @Post('unit-pricing-suggestions/apply')
  applyUnitPricing(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ApplyUnitPricingDto,
    @Req() req: Request,
  ): Promise<ApplyUnitPricingResultDto> {
    return this.insights.applyUnitPricing({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId: body.unitId,
      price: body.price,
      meta: extractMeta(req),
    });
  }

  @Get('forecast')
  getForecast(
    @CurrentUser() user: AuthenticatedUser,
    @Query('months') months?: string,
  ): Promise<RevenueForecastDto> {
    const parsed = months ? Number.parseInt(months, 10) : undefined;
    return this.insights.getRevenueForecast(user.tenantId, {
      ...(parsed && Number.isFinite(parsed) ? { months: parsed } : {}),
    });
  }
}

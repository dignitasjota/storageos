import { Body, Controller, Get, Post, Put, Query, Req } from '@nestjs/common';
import {
  ApplyPricingSchema,
  ApplyUnitPricingSchema,
  UpdatePricingStrategySchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { resolveAnalyticsScope } from './analytics-scope';
import { AnalyticsTrendsService } from './analytics-trends.service';
import { AnalyticsService } from './analytics.service';
import { BenchmarkService } from './benchmark.service';
import { InsightsService } from './insights.service';
import { SuggestedActionsService } from './suggested-actions.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  AgingKpiDto,
  CohortsDto,
  CompetitionAlertsDto,
  OccupancyHistoryDto,
  RevenueBreakdownDto,
  PriceChangeEffectsDto,
  PricingStrategyDto,
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
  SeoChecklistDto,
  SuggestedActionsDto,
  UnitPricingSuggestionsDto,
  WebPerformanceDto,
} from '@storageos/shared';
import type { Request } from 'express';

class ApplyPricingDto extends createZodDto(ApplyPricingSchema) {}
class ApplyUnitPricingDto extends createZodDto(ApplyUnitPricingSchema) {}
class UpdatePricingStrategyDto extends createZodDto(UpdatePricingStrategySchema) {}

/** Local de la consulta: el pedido (si el usuario lo ve) o los de su alcance. */
function scopeOf(user: AuthenticatedUser, facilityId?: string) {
  return resolveAnalyticsScope(user.facilityScope ?? null, facilityId);
}

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
    private readonly suggestedActions: SuggestedActionsService,
    private readonly trends: AnalyticsTrendsService,
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
    return this.service.getOccupancy(user.tenantId, scopeOf(user, facilityId));
  }

  @Get('customers')
  getCustomerStats(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<CustomerStatsKpiDto> {
    return this.service.getCustomerStats(user.tenantId, scopeOf(user, facilityId));
  }

  @Get('revenue')
  getRevenue(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<RevenueKpiDto> {
    return this.service.getRevenue(user.tenantId, scopeOf(user, facilityId));
  }

  @Get('monthly-revenue')
  getMonthlyRevenue(
    @CurrentUser() user: AuthenticatedUser,
    @Query('months') months?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<MonthlyRevenueKpiDto> {
    const parsed = months ? Number.parseInt(months, 10) : undefined;
    return this.service.getMonthlyRevenue(
      user.tenantId,
      {
        ...(parsed && Number.isFinite(parsed) ? { months: parsed } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
      scopeOf(user, facilityId),
    );
  }

  @Get('churn')
  getChurn(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<ChurnKpiDto> {
    return this.service.getChurn(
      user.tenantId,
      { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      scopeOf(user, facilityId),
    );
  }

  @Get('aging')
  getAging(
    @CurrentUser() user: AuthenticatedUser,
    @Query('atDate') atDate?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<AgingKpiDto> {
    return this.service.getAging(user.tenantId, atDate, scopeOf(user, facilityId));
  }

  @Get('leads-funnel')
  getLeadsFunnel(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<LeadsFunnelKpiDto> {
    return this.service.getLeadsFunnel(
      user.tenantId,
      { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      scopeOf(user, facilityId),
    );
  }

  @Get('leads-utm')
  getLeadsUtm(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<LeadsUtmKpiDto> {
    return this.service.getLeadsUtm(
      user.tenantId,
      { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      scopeOf(user, facilityId),
    );
  }

  /** Rendimiento de la web pública (Web Premium): leads → contrato → MRR. */
  @RequireFeature('web_premium')
  @Get('web-performance')
  getWebPerformance(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<WebPerformanceDto> {
    return this.service.getWebPerformance(user.tenantId, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }

  /**
   * Revisión de SEO de la web: parte del extra «SEO local». Los ítems de
   * `premium` se muestran igualmente (upsell de Web Premium si no la tiene).
   */
  @RequireFeature('local_seo')
  @Get('seo-checklist')
  getSeoChecklist(@CurrentUser() user: AuthenticatedUser): Promise<SeoChecklistDto> {
    return this.service.getSeoChecklist(user.tenantId);
  }

  /** Ocupación al final de cada mes (por local y por tipo). */
  @Get('occupancy-history')
  getOccupancyHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query('months') months?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<OccupancyHistoryDto> {
    const parsed = months ? Number.parseInt(months, 10) : undefined;
    return this.trends.getOccupancyHistory(user.tenantId, parsed, scopeOf(user, facilityId));
  }

  /** Lo facturado por concepto, local y tipo de trastero. */
  @Get('revenue-breakdown')
  getRevenueBreakdown(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<RevenueBreakdownDto> {
    return this.trends.getRevenueBreakdown(
      user.tenantId,
      { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      scopeOf(user, facilityId),
    );
  }

  /** Cohortes de altas: permanencia y facturación según el mes en que empezaron. */
  @Get('cohorts')
  getCohorts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('months') months?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<CohortsDto> {
    const parsed = months ? Number.parseInt(months, 10) : undefined;
    return this.trends.getCohorts(user.tenantId, parsed, scopeOf(user, facilityId));
  }

  /** Competidores sin revisar y bajadas de precio donde eres más caro. */
  @Get('competition-alerts')
  getCompetitionAlerts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<CompetitionAlertsDto> {
    return this.insights.getCompetitionAlerts(user.tenantId, scopeOf(user, facilityId));
  }

  @Get('churn-risk')
  getChurnRisk(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<ChurnRiskKpiDto> {
    return this.insights.getChurnRisk(user.tenantId, scopeOf(user, facilityId));
  }

  /** «Sugerencias de hoy»: acciones concretas priorizadas para el dashboard. */
  @Get('suggested-actions')
  getSuggestedActions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<SuggestedActionsDto> {
    return this.suggestedActions.get(user.tenantId, scopeOf(user, facilityId));
  }

  @Get('pricing-suggestions')
  getPricingSuggestions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<PricingSuggestionsDto> {
    return this.insights.getPricingSuggestions(user.tenantId, scopeOf(user, facilityId));
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
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Sugerencia de precio por trastero (mercado + posicionamiento + demanda; `includeCompetition=false` la omite). */
  @Get('unit-pricing-suggestions')
  getUnitPricingSuggestions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('includeCompetition') includeCompetition?: string,
  ): Promise<UnitPricingSuggestionsDto> {
    return this.insights.getUnitPricingSuggestions(
      user.tenantId,
      scopeOf(user, facilityId),
      includeCompetition !== 'false',
    );
  }

  /** Efecto de tus cambios de precio: cuánto tardó luego en alquilarse cada trastero. */
  @Get('price-change-effects')
  getPriceChangeEffects(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<PriceChangeEffectsDto> {
    return this.insights.getPriceChangeEffects(user.tenantId, scopeOf(user, facilityId));
  }

  /** Estrategia de precios: ocupación objetivo, límites y posicionamiento por local. */
  @Get('pricing-strategy')
  getPricingStrategy(@CurrentUser() user: AuthenticatedUser): Promise<PricingStrategyDto> {
    return this.insights.getPricingStrategy(user.tenantId);
  }

  @RequirePermission('units:manage')
  @Put('pricing-strategy')
  updatePricingStrategy(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdatePricingStrategyDto,
    @Req() req: Request,
  ): Promise<PricingStrategyDto> {
    return this.insights.updatePricingStrategy({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
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
      facilityScope: user.facilityScope ?? null,
    });
  }

  @Get('forecast')
  getForecast(
    @CurrentUser() user: AuthenticatedUser,
    @Query('months') months?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<RevenueForecastDto> {
    const parsed = months ? Number.parseInt(months, 10) : undefined;
    return this.insights.getRevenueForecast(
      user.tenantId,
      { ...(parsed && Number.isFinite(parsed) ? { months: parsed } : {}) },
      scopeOf(user, facilityId),
    );
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateMetricAnnotationSchema,
  UpdateMetricAnnotationSchema,
  type AdminBreakdownDto,
  type AdminClientStatesDto,
  type AdminConcentrationDto,
  type AdminMetricAnnotationDto,
  type AdminRevenueSeriesDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { parseMonthsParam } from '../../common/saas-metrics';

import { AdminAudit } from './admin-audit.decorator';
import { AdminMetricsInsightsService } from './admin-metrics-insights.service';
import { AdminMetricsService } from './admin-metrics.service';
import { AdminGuard } from './admin.guard';
import { CurrentSuperAdmin } from './current-super-admin.decorator';
import { MrrSnapshotService } from './mrr-snapshot.service';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type {
  AdminChurnByReasonDto,
  AdminLtvDto,
  AdminMetricsDto,
  AdminMetricsMrrMovementsDto,
  AdminMrrForecastDto,
  AdminPaymentRetryAnalysisDto,
  AdminRetentionDto,
} from '@storageos/shared';

class CreateMetricAnnotationDto extends createZodDto(CreateMetricAnnotationSchema) {}
class UpdateMetricAnnotationDto extends createZodDto(UpdateMetricAnnotationSchema) {}

@Public()
@UseGuards(AdminGuard)
@Controller('admin/metrics')
export class AdminMetricsController {
  constructor(
    private readonly metrics: AdminMetricsService,
    private readonly mrr: MrrSnapshotService,
    private readonly insights: AdminMetricsInsightsService,
  ) {}

  @Get()
  async overview(@Query('months') months?: string): Promise<AdminMetricsDto> {
    return this.metrics.getOverview(parseMonthsParam(months, 12));
  }

  /** Desglose mensual del cambio de MRR (new/expansion/contraction/churn/...). */
  @Get('mrr-movements')
  async mrrMovements(@Query('months') months?: string): Promise<AdminMetricsMrrMovementsDto> {
    return this.mrr.getMovements(parseMonthsParam(months, 12));
  }

  /** Previsión de MRR a `months` meses vista (default 6). */
  @Get('mrr-forecast')
  async mrrForecast(@Query('months') months?: string): Promise<AdminMrrForecastDto> {
    return this.mrr.getForecast(12, parseMonthsParam(months, 6));
  }

  /** Matriz de cohortes de retención de tenants (por mes de alta). */
  @Get('retention')
  async retention(@Query('months') months?: string): Promise<AdminRetentionDto> {
    return this.metrics.getRetention(parseMonthsParam(months, 12));
  }

  /** Churn de tenants agrupado por motivo de baja (capturado o inferido). */
  @Get('churn-by-reason')
  async churnByReason(@Query('months') months?: string): Promise<AdminChurnByReasonDto> {
    return this.metrics.getChurnByReason(parseMonthsParam(months, 12));
  }

  /** LTV + cohortes de ingresos del SaaS (por mes de alta). */
  @Get('ltv')
  async ltv(@Query('months') months?: string): Promise<AdminLtvDto> {
    return this.metrics.getLtv(parseMonthsParam(months, 12));
  }

  /** Retry analysis: recuperación de cobros fallidos de la suscripción SaaS. */
  @Get('payment-retries')
  async paymentRetries(@Query('months') months?: string): Promise<AdminPaymentRetryAnalysisDto> {
    return this.metrics.getPaymentRetryAnalysis(parseMonthsParam(months, 12));
  }

  /** Clientes por estado con su MRR y la evolución mes a mes. */
  @Get('states')
  states(@Query('months') months?: string): Promise<AdminClientStatesDto> {
    return this.insights.clientStates(parseMonthsParam(months, 12));
  }

  /** Peso de los mayores clientes en el MRR. */
  @Get('concentration')
  concentration(): Promise<AdminConcentrationDto> {
    return this.insights.concentration();
  }

  /** Serie mensual por plan, extra, forma de cobro o comercial. */
  @Get('revenue-series')
  revenueSeries(
    @Query('by') by = 'plan',
    @Query('months') months?: string,
  ): Promise<AdminRevenueSeriesDto> {
    return this.insights.revenueSeries(by, parseMonthsParam(months, 12));
  }

  /** Los tenants que forman una cifra (`metric`, y `month`, `plan` o `kind` según la cifra). */
  @Get('breakdown')
  breakdown(
    @Query('metric') metric = '',
    @Query('month') month?: string,
    @Query('plan') plan?: string,
    @Query('kind') kind?: string,
  ): Promise<AdminBreakdownDto> {
    return this.insights.breakdown({
      metric,
      ...(month ? { month } : {}),
      ...(plan ? { plan } : {}),
      ...(kind ? { kind } : {}),
    });
  }

  /** Anotaciones e hitos de los gráficos. */
  @Get('annotations')
  annotations(): Promise<AdminMetricAnnotationDto[]> {
    return this.insights.listAnnotations();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.metric_annotation.created')
  @Post('annotations')
  createAnnotation(
    @CurrentSuperAdmin('sub') authorId: string,
    @Body() input: CreateMetricAnnotationDto,
  ): Promise<AdminMetricAnnotationDto> {
    return this.insights.createAnnotation(input, authorId);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.metric_annotation.updated')
  @Patch('annotations/:id')
  updateAnnotation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateMetricAnnotationDto,
  ): Promise<AdminMetricAnnotationDto> {
    return this.insights.updateAnnotation(id, input);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.metric_annotation.deleted')
  @Delete('annotations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAnnotation(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.insights.deleteAnnotation(id);
  }
}

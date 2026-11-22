import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { parseMonthsParam } from '../../common/saas-metrics';

import { AdminMetricsService } from './admin-metrics.service';
import { AdminGuard } from './admin.guard';
import { MrrSnapshotService } from './mrr-snapshot.service';

import type {
  AdminChurnByReasonDto,
  AdminLtvDto,
  AdminMetricsDto,
  AdminMetricsMrrMovementsDto,
  AdminMrrForecastDto,
  AdminPaymentRetryAnalysisDto,
  AdminRetentionDto,
} from '@storageos/shared';

@Public()
@UseGuards(AdminGuard)
@Controller('admin/metrics')
export class AdminMetricsController {
  constructor(
    private readonly metrics: AdminMetricsService,
    private readonly mrr: MrrSnapshotService,
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
}

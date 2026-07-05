import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

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
  async overview(): Promise<AdminMetricsDto> {
    return this.metrics.getOverview();
  }

  /** Desglose mensual del cambio de MRR (new/expansion/contraction/churn/...). */
  @Get('mrr-movements')
  async mrrMovements(@Query('months') months?: string): Promise<AdminMetricsMrrMovementsDto> {
    const n = months ? Number(months) : 12;
    return this.mrr.getMovements(Number.isFinite(n) ? n : 12);
  }

  /** Previsión de MRR a `months` meses vista (default 6). */
  @Get('mrr-forecast')
  async mrrForecast(@Query('months') months?: string): Promise<AdminMrrForecastDto> {
    const n = months ? Number(months) : 6;
    return this.mrr.getForecast(12, Number.isFinite(n) ? n : 6);
  }

  /** Matriz de cohortes de retención de tenants (por mes de alta). */
  @Get('retention')
  async retention(@Query('months') months?: string): Promise<AdminRetentionDto> {
    const n = months ? Number(months) : 12;
    return this.metrics.getRetention(Number.isFinite(n) ? n : 12);
  }

  /** Churn de tenants agrupado por motivo de baja (capturado o inferido). */
  @Get('churn-by-reason')
  async churnByReason(@Query('months') months?: string): Promise<AdminChurnByReasonDto> {
    const n = months ? Number(months) : 12;
    return this.metrics.getChurnByReason(Number.isFinite(n) ? n : 12);
  }

  /** LTV + cohortes de ingresos del SaaS (por mes de alta). */
  @Get('ltv')
  async ltv(@Query('months') months?: string): Promise<AdminLtvDto> {
    const n = months ? Number(months) : 12;
    return this.metrics.getLtv(Number.isFinite(n) ? n : 12);
  }

  /** Retry analysis: recuperación de cobros fallidos de la suscripción SaaS. */
  @Get('payment-retries')
  async paymentRetries(@Query('months') months?: string): Promise<AdminPaymentRetryAnalysisDto> {
    const n = months ? Number(months) : 12;
    return this.metrics.getPaymentRetryAnalysis(Number.isFinite(n) ? n : 12);
  }
}

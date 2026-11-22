import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  UpdateFinanceSettingsSchema,
  UpdateMarketingSpendSchema,
  type AdminAcquisitionDto,
  type AdminCashMonthDto,
  type AdminCollectionsForecastDto,
  type AdminFinanceOverviewDto,
  type AdminFinanceSettingsDto,
  type AdminMarginDto,
  type AdminVatQuarterlyDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { madridMonthIndex, parseMonthsParam } from '../../common/saas-metrics';

import { AdminAudit } from './admin-audit.decorator';
import { AdminBillingOpsService } from './admin-billing-ops.service';
import { AdminFinanceInsightsService } from './admin-finance-insights.service';
import { AdminFinanceService } from './admin-finance.service';
import { AdminGuard } from './admin.guard';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { Response } from 'express';

class UpdateFinanceSettingsDto extends createZodDto(UpdateFinanceSettingsSchema) {}
class UpdateMarketingSpendDto extends createZodDto(UpdateMarketingSpendSchema) {}

/** `vat=without` → importes sin IVA; cualquier otro valor, con IVA. */
const withVat = (vat?: string) => vat !== 'without';

/** Año de la URL o el actual (en hora de España). */
const yearParam = (raw?: string) => {
  const n = Number(raw);
  return raw && Number.isInteger(n) ? n : Math.floor(madridMonthIndex(new Date()) / 12);
};

/** Dashboard financiero del SaaS (super admin). */
@Public()
@Controller('admin/finance')
@UseGuards(AdminGuard)
export class AdminFinanceController {
  constructor(
    private readonly service: AdminFinanceService,
    private readonly billingOps: AdminBillingOpsService,
    private readonly insights: AdminFinanceInsightsService,
  ) {}

  @Get()
  overview(
    @Query('months') months?: string,
    @Query('vat') vat?: string,
  ): Promise<AdminFinanceOverviewDto> {
    return this.service.getOverview(parseMonthsParam(months, 12), withVat(vat));
  }

  /** Lo que se espera cobrar en los próximos 30/60/90 días por forma de cobro. */
  @Get('forecast')
  forecast(): Promise<AdminCollectionsForecastDto> {
    return this.billingOps.collectionsForecast();
  }

  /** Lo cobrado este mes y lo que queda por cobrar, frente al objetivo. */
  @Get('cash-month')
  cashMonth(): Promise<AdminCashMonthDto> {
    return this.insights.cashMonth();
  }

  /** IVA repercutido de las facturas de suscripción por trimestre. */
  @Get('vat-quarterly')
  vatQuarterly(@Query('year') year?: string): Promise<AdminVatQuarterlyDto> {
    return this.insights.vatQuarterly(yearParam(year));
  }

  /** Margen por mes y por tenant con los costes estimados. */
  @Get('margin')
  margin(@Query('months') months?: string): Promise<AdminMarginDto> {
    return this.insights.margin(parseMonthsParam(months, 12));
  }

  /** Coste de adquisición y meses de recuperación. */
  @Get('acquisition')
  acquisition(@Query('months') months?: string): Promise<AdminAcquisitionDto> {
    return this.insights.acquisition(parseMonthsParam(months, 12));
  }

  @Get('settings')
  settings(): Promise<AdminFinanceSettingsDto> {
    return this.insights.getSettings();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.finance_settings.updated')
  @Put('settings')
  @HttpCode(HttpStatus.OK)
  updateSettings(@Body() input: UpdateFinanceSettingsDto): Promise<AdminFinanceSettingsDto> {
    return this.insights.updateSettings(input);
  }

  @Get('marketing-spend')
  marketingSpend(
    @Query('months') months?: string,
  ): Promise<{ month: string; amount: number; note: string | null }[]> {
    return this.insights.listMarketingSpend(parseMonthsParam(months, 12));
  }

  @RequireSuperadmin()
  @AdminAudit('admin.marketing_spend.updated')
  @Put('marketing-spend/:month')
  @HttpCode(HttpStatus.OK)
  setMarketingSpend(
    @Param('month') month: string,
    @Body() input: UpdateMarketingSpendDto,
  ): Promise<{ month: string; amount: number; note: string | null }> {
    return this.insights.setMarketingSpend(month, input);
  }

  /** CSV: `kind` = monthly, providers, vat, margin o reconciliation. */
  @Get('export.csv')
  async exportCsv(
    @Res({ passthrough: true }) res: Response,
    @Query('kind') kind = 'monthly',
    @Query('months') months?: string,
    @Query('vat') vat?: string,
    @Query('year') year?: string,
  ): Promise<string> {
    const file = await this.insights.csv(kind, {
      months: parseMonthsParam(months, 12),
      vatIncluded: withVat(vat),
      year: yearParam(year),
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return file.body;
  }

  /** Informe de Finanzas en PDF. */
  @Get('report.pdf')
  async reportPdf(
    @Query('months') months?: string,
    @Query('vat') vat?: string,
  ): Promise<StreamableFile> {
    const span = parseMonthsParam(months, 12);
    const pdf = await this.insights.pdf(span, withVat(vat));
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename="finanzas-${span}m.pdf"`,
    });
  }
}

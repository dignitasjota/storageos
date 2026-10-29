import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  type AdminBusinessAlertsDto,
  type AdminBusinessGoalsDto,
  type AdminMonthlyReportDto,
  type AdminTenantBusinessDto,
  type AdminTrialFunnelDto,
  UpdateBusinessAlertSettingsSchema,
  UpdateBusinessGoalsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminAudit } from './admin-audit.decorator';
import { AdminBusinessService } from './admin-business.service';
import { AdminGuard } from './admin.guard';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { Response } from 'express';

class UpdateBusinessGoalsDto extends createZodDto(UpdateBusinessGoalsSchema) {}
class UpdateBusinessAlertSettingsDto extends createZodDto(UpdateBusinessAlertSettingsSchema) {}

/** Apartado «Negocio» del panel super admin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/business')
export class AdminBusinessController {
  constructor(private readonly business: AdminBusinessService) {}

  /** Embudo de pruebas por mes de alta. */
  @Get('trial-funnel')
  trialFunnel(@Query('months') months?: string): Promise<AdminTrialFunnelDto> {
    return this.business.trialFunnel(months ? Number(months) : 12);
  }

  @Get('goals')
  goals(): Promise<AdminBusinessGoalsDto> {
    return this.business.getGoals();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.business_goals.updated')
  @Put('goals')
  @HttpCode(HttpStatus.OK)
  updateGoals(@Body() input: UpdateBusinessGoalsDto): Promise<AdminBusinessGoalsDto> {
    return this.business.updateGoals(input);
  }

  /** Avisos de negocio de ahora mismo y sus umbrales. */
  @Get('alerts')
  alerts(): Promise<AdminBusinessAlertsDto> {
    return this.business.businessAlerts();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.business_alerts.settings_updated')
  @Put('alerts/settings')
  @HttpCode(HttpStatus.OK)
  updateAlertSettings(
    @Body() input: UpdateBusinessAlertSettingsDto,
  ): Promise<AdminBusinessAlertsDto> {
    return this.business.updateAlertSettings(input);
  }

  /** Ficha de negocio de un tenant (MRR, pagos, salud, uso y adopción). */
  @Get('tenants/:id')
  tenant(@Param('id', ParseUUIDPipe) id: string): Promise<AdminTenantBusinessDto> {
    return this.business.tenantBusiness(id);
  }

  /** Informe del mes: `format=json` (por defecto), `csv` o `pdf`. */
  @Get('monthly-report')
  async monthlyReport(
    @Res({ passthrough: true }) res: Response,
    @Query('month') month = '',
    @Query('format') format = 'json',
  ): Promise<AdminMonthlyReportDto | StreamableFile | string> {
    const report = await this.business.monthlyReport(month);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="informe-${month}.csv"`);
      return this.business.monthlyReportCsv(report);
    }
    if (format === 'pdf') {
      const pdf = await this.business.monthlyReportPdf(report);
      return new StreamableFile(pdf, {
        type: 'application/pdf',
        disposition: `attachment; filename="informe-${month}.pdf"`,
      });
    }
    return report;
  }
}

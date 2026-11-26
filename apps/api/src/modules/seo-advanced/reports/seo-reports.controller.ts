import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  SendSeoReportSchema,
  SilenceSeoAlertSchema,
  UpdateSeoAlertSettingsSchema,
  UpdateSeoConversionSettingsSchema,
  UpdateSeoReportSettingsSchema,
  type SeoAlertSettings,
  type SeoConversionsDto,
  type SeoProjectAlertDto,
  type SeoProjectAlertListDto,
  type SeoReportContentDto,
  type SeoReportDto,
  type SeoReportKind,
  type SeoReportSettings,
  type SeoReportsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { RequireFeature } from '../../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { AdminAudit } from '../../admin/admin-audit.decorator';
import { AdminGuard } from '../../admin/admin.guard';
import { CurrentSuperAdmin } from '../../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../../admin/require-superadmin.decorator';
import { parsePanelQuery } from '../seo-days';
import { SeoProjectsService } from '../seo-projects.service';

import { SeoAlertsService, parseSeoAlertQuery } from './seo-alerts.service';
import { SeoConversionsService } from './seo-conversions.service';
import { SeoReportsService } from './seo-reports.service';

class SilenceDto extends createZodDto(SilenceSeoAlertSchema) {}
class AlertSettingsDto extends createZodDto(UpdateSeoAlertSettingsSchema) {}
class ReportSettingsDto extends createZodDto(UpdateSeoReportSettingsSchema) {}
class SendReportDto extends createZodDto(SendSeoReportSchema) {}
class ConversionSettingsDto extends createZodDto(UpdateSeoConversionSettingsSchema) {}

const kindOf = (v: string | undefined): SeoReportKind => (v === 'monthly' ? 'monthly' : 'weekly');

/**
 * Lo que trae Google, alertas e informes del proyecto del tenant (PR 8). Ver
 * con `analytics:read`; cambiar con `settings:manage`. «Enviármelo ahora»
 * solo manda el informe a quien lo pide (con ver basta).
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced')
export class SeoAdvancedReportsController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly conversions: SeoConversionsService,
    private readonly alerts: SeoAlertsService,
    private readonly reports: SeoReportsService,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  @RequirePermission('analytics:read')
  @Get('conversions')
  async conversionsSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoConversionsDto> {
    return this.conversions.summary(
      user.tenantId,
      await this.projectId(user),
      parsePanelQuery(query),
    );
  }

  @RequirePermission('settings:manage')
  @Post('conversions/recalc')
  @HttpCode(200)
  async recalc(@CurrentUser() user: AuthenticatedUser) {
    return this.conversions.recalc(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('alerts')
  async listAlerts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoProjectAlertListDto> {
    return this.alerts.list(user.tenantId, await this.projectId(user), parseSeoAlertQuery(query));
  }

  @RequirePermission('settings:manage')
  @Post('alerts/check')
  @HttpCode(200)
  async checkAlerts(@CurrentUser() user: AuthenticatedUser) {
    return this.alerts.checkNow(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Put('alerts/settings')
  async alertSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: AlertSettingsDto,
  ): Promise<SeoAlertSettings> {
    return this.alerts.updateSettings(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('settings:manage')
  @Post('alerts/:alertId/silence')
  @HttpCode(200)
  async silence(
    @CurrentUser() user: AuthenticatedUser,
    @Param('alertId', ParseUUIDPipe) alertId: string,
    @Body() body: SilenceDto,
  ): Promise<SeoProjectAlertDto> {
    return this.alerts.silence(user.tenantId, await this.projectId(user), alertId, body.days);
  }

  @RequirePermission('settings:manage')
  @Post('alerts/:alertId/unsilence')
  @HttpCode(200)
  async unsilence(
    @CurrentUser() user: AuthenticatedUser,
    @Param('alertId', ParseUUIDPipe) alertId: string,
  ): Promise<SeoProjectAlertDto> {
    return this.alerts.unsilence(user.tenantId, await this.projectId(user), alertId);
  }

  @RequirePermission('settings:manage')
  @Post('alerts/:alertId/resolve')
  @HttpCode(200)
  async resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('alertId', ParseUUIDPipe) alertId: string,
  ): Promise<SeoProjectAlertDto> {
    return this.alerts.resolve(user.tenantId, await this.projectId(user), alertId);
  }

  @RequirePermission('analytics:read')
  @Get('reports')
  async listReports(@CurrentUser() user: AuthenticatedUser): Promise<SeoReportsDto> {
    return this.reports.overview(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('reports/preview')
  async preview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('kind') kind: string | undefined,
  ): Promise<SeoReportContentDto> {
    return this.reports.preview(user.tenantId, await this.projectId(user), kindOf(kind));
  }

  @RequirePermission('settings:manage')
  @Put('reports/settings')
  async reportSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ReportSettingsDto,
  ): Promise<SeoReportSettings> {
    return this.reports.updateSettings(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('analytics:read')
  @Post('reports/send')
  @HttpCode(200)
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SendReportDto,
  ): Promise<SeoReportDto> {
    return this.reports.sendNow(user.tenantId, await this.projectId(user), body.kind, {
      userId: user.sub,
    });
  }

  @RequirePermission('analytics:read')
  @Get('reports/:reportId/pdf')
  async pdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ): Promise<{ url: string }> {
    return this.reports.pdfUrl(user.tenantId, await this.projectId(user), reportId);
  }
}

/**
 * Lo mismo en el panel admin. Leer: cualquier super admin (también los
 * proyectos de los tenants); cambiar y enviar: el rol superadmin y solo en
 * los proyectos de la plataforma.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id')
export class AdminSeoReportsController {
  constructor(
    private readonly conversions: SeoConversionsService,
    private readonly alerts: SeoAlertsService,
    private readonly reports: SeoReportsService,
  ) {}

  @Get('conversions')
  conversionsSummary(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoConversionsDto> {
    return this.conversions.summary(undefined, id, parsePanelQuery(query));
  }

  @Post('conversions/recalc')
  @RequireSuperadmin()
  @HttpCode(200)
  recalc(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversions.recalc(null, id);
  }

  @Put('conversions/settings')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.conversion_settings_changed')
  conversionSettings(@Param('id', ParseUUIDPipe) id: string, @Body() body: ConversionSettingsDto) {
    return this.conversions.setPlatformConversions(id, body.platformConversions);
  }

  @Get('alerts')
  listAlerts(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoProjectAlertListDto> {
    return this.alerts.list(undefined, id, parseSeoAlertQuery(query));
  }

  @Post('alerts/check')
  @RequireSuperadmin()
  @HttpCode(200)
  checkAlerts(@Param('id', ParseUUIDPipe) id: string) {
    return this.alerts.checkNow(null, id);
  }

  @Put('alerts/settings')
  @RequireSuperadmin()
  alertSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AlertSettingsDto,
  ): Promise<SeoAlertSettings> {
    return this.alerts.updateSettings(null, id, body);
  }

  @Post('alerts/:alertId/silence')
  @RequireSuperadmin()
  @HttpCode(200)
  silence(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('alertId', ParseUUIDPipe) alertId: string,
    @Body() body: SilenceDto,
  ): Promise<SeoProjectAlertDto> {
    return this.alerts.silence(null, id, alertId, body.days);
  }

  @Post('alerts/:alertId/unsilence')
  @RequireSuperadmin()
  @HttpCode(200)
  unsilence(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('alertId', ParseUUIDPipe) alertId: string,
  ): Promise<SeoProjectAlertDto> {
    return this.alerts.unsilence(null, id, alertId);
  }

  @Post('alerts/:alertId/resolve')
  @RequireSuperadmin()
  @HttpCode(200)
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('alertId', ParseUUIDPipe) alertId: string,
  ): Promise<SeoProjectAlertDto> {
    return this.alerts.resolve(null, id, alertId);
  }

  @Get('reports')
  listReports(@Param('id', ParseUUIDPipe) id: string): Promise<SeoReportsDto> {
    return this.reports.overview(undefined, id);
  }

  @Get('reports/preview')
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('kind') kind: string | undefined,
  ): Promise<SeoReportContentDto> {
    return this.reports.preview(undefined, id, kindOf(kind));
  }

  @Put('reports/settings')
  @RequireSuperadmin()
  reportSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReportSettingsDto,
  ): Promise<SeoReportSettings> {
    return this.reports.updateSettings(null, id, body);
  }

  @Post('reports/send')
  @RequireSuperadmin()
  @HttpCode(200)
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() body: SendReportDto,
  ): Promise<SeoReportDto> {
    return this.reports.sendNow(null, id, body.kind, { superAdminId });
  }

  @Get('reports/:reportId/pdf')
  pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ): Promise<{ url: string }> {
    return this.reports.pdfUrl(undefined, id, reportId);
  }
}

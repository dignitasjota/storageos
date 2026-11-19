import {
  BadGatewayException,
  BadRequestException,
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
  Put,
  Query,
} from '@nestjs/common';
import {
  ConnectSearchConsoleSchema,
  SeoMonthlyReportToggleSchema,
  CreateTrackedKeywordSchema,
  UpdateSeoSettingsSchema,
  type SeoDetailDto,
  type SeoGoogleFunnelDto,
  type TrackedKeywordDto,
  type SearchConsoleSettingsDto,
  type SeoMonthlyReportDto,
  type SeoPositionsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { SearchConsoleService } from './search-console.service';
import { SeoReportService } from './seo-report.service';

class ConnectSearchConsoleDto extends createZodDto(ConnectSearchConsoleSchema) {}
class ToggleReportDto extends createZodDto(SeoMonthlyReportToggleSchema) {}
class UpdateSeoSettingsDto extends createZodDto(UpdateSeoSettingsSchema) {}
class CreateTrackedKeywordDto extends createZodDto(CreateTrackedKeywordSchema) {}

/** Posiciones en Google con Search Console. Extra «SEO local». */
@RequireFeature('local_seo')
@Controller('seo')
export class SearchConsoleController {
  constructor(
    private readonly gsc: SearchConsoleService,
    private readonly report: SeoReportService,
  ) {}

  // Quien ve la analítica ve si está conectado (la página depende de ello).
  @RequirePermission('analytics:read')
  @Get('search-console')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<SearchConsoleSettingsDto> {
    return this.gsc.settings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Put('search-console')
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConnectSearchConsoleDto,
  ): Promise<SearchConsoleSettingsDto> {
    return this.gsc.connect(user.tenantId, body.siteUrl);
  }

  @RequirePermission('settings:manage')
  @Delete('search-console')
  disconnect(@CurrentUser() user: AuthenticatedUser): Promise<SearchConsoleSettingsDto> {
    return this.gsc.disconnect(user.tenantId);
  }

  /** Descarga ya los últimos días (sin esperar al cron). */
  @RequirePermission('settings:manage')
  @Post('search-console/sync')
  async sync(@CurrentUser() user: AuthenticatedUser): Promise<SearchConsoleSettingsDto> {
    const { ok } = await this.gsc.sync(user.tenantId);
    const settings = await this.gsc.settings(user.tenantId);
    if (!ok) {
      throw new BadGatewayException({
        code: 'search_console_sync_failed',
        message: settings.lastError ?? 'No se pudieron descargar los datos de Google.',
      });
    }
    return settings;
  }

  @RequirePermission('analytics:read')
  @Get('positions')
  positions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<SeoPositionsDto> {
    return this.gsc.positions(user.tenantId, Number(days) || 28);
  }

  /** Informe de un mes (`?month=AAAA-MM`; por defecto, el mes pasado). */
  @RequirePermission('analytics:read')
  @Get('report')
  monthlyReport(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
  ): Promise<SeoMonthlyReportDto> {
    return this.report.build(user.tenantId, month || undefined);
  }

  /** Envía ya el informe del mes pasado a quien lo pide. */
  @RequirePermission('analytics:read')
  @Post('report/send')
  sendReport(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ recipients: number; month: string }> {
    return this.report.send(user.tenantId, { toUserId: user.sub });
  }

  @RequirePermission('settings:manage')
  @Put('search-console/report')
  async toggleReport(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ToggleReportDto,
  ): Promise<SearchConsoleSettingsDto> {
    await this.report.setMonthlyReport(user.tenantId, body.enabled);
    return this.gsc.settings(user.tenantId);
  }

  /** Palabras de la marca y quién recibe el informe mensual. */
  @RequirePermission('settings:manage')
  @Patch('search-console/settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateSeoSettingsDto,
  ): Promise<SearchConsoleSettingsDto> {
    return this.gsc.updateSettings(user.tenantId, body);
  }

  @RequirePermission('analytics:read')
  @Get('keywords')
  keywords(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<TrackedKeywordDto[]> {
    return this.gsc.listKeywords(user.tenantId, Number(days) || 28);
  }

  @RequirePermission('settings:manage')
  @Post('keywords')
  @HttpCode(HttpStatus.NO_CONTENT)
  async addKeyword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateTrackedKeywordDto,
  ): Promise<void> {
    await this.gsc.addKeyword(user.tenantId, body);
  }

  @RequirePermission('settings:manage')
  @Delete('keywords/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeKeyword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.gsc.removeKeyword(user.tenantId, id);
  }

  /** Una búsqueda (`?query=`) o una página (`?page=`) día a día. */
  @RequirePermission('analytics:read')
  @Get('detail')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Query('query') query?: string,
    @Query('page') page?: string,
    @Query('days') days?: string,
  ): Promise<SeoDetailDto> {
    const key = (query ?? page ?? '').slice(0, 1000);
    if (!key) {
      throw new BadRequestException({
        code: 'detail_required',
        message: 'Indica la búsqueda o la página',
      });
    }
    return this.gsc.detail(user.tenantId, query ? 'query' : 'page', key, Number(days) || 28);
  }

  /** De Google a reservas en el periodo. */
  @RequirePermission('analytics:read')
  @Get('google-funnel')
  googleFunnel(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<SeoGoogleFunnelDto> {
    return this.gsc.googleFunnel(user.tenantId, Number(days) || 28);
  }
}

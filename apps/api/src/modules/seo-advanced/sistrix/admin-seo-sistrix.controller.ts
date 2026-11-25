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
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  AddSeoProjectKeywordsSchema,
  CreateSeoCompetitorSchema,
  SeoSistrixSyncSchema,
  SetProjectPlatformSistrixSchema,
  UpdateSeoCompetitorSchema,
  UpdateSeoProjectKeywordSchema,
  UpdateSeoSyncSettingsSchema,
  UpdateSistrixApiSettingsSchema,
  type SeoAiVisibilityRowDto,
  type SeoBacklinksDto,
  type SeoCompetitorDto,
  type SeoDomainKeywordHistoryDto,
  type SeoDomainKeywordsDto,
  type SeoOpportunitiesDto,
  type SeoProjectKeywordDto,
  type SeoSerpDto,
  type SeoSistrixApiDto,
  type SeoSistrixIntegrationsDto,
  type SeoSistrixRequestsPageDto,
  type SeoSistrixRunDto,
  type SeoSistrixTestResultDto,
  type SeoSistrixWorkspaceDto,
  type SeoSyncSettingsDto,
  type SeoVisibilitySeriesDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../../common/decorators/public.decorator';
import { ThrottleLogin } from '../../../common/decorators/throttle-presets';
import { AdminAudit } from '../../admin/admin-audit.decorator';
import { AdminGuard } from '../../admin/admin.guard';
import { CurrentSuperAdmin } from '../../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../../admin/require-superadmin.decorator';

import { SeoSistrixDataService } from './seo-sistrix-data.service';
import { SeoSistrixService } from './seo-sistrix.service';
import { SistrixOAuthService } from './sistrix-oauth.service';

import type { Response } from 'express';

class UpdateApiDto extends createZodDto(UpdateSistrixApiSettingsSchema) {}
class UpdateSettingsDto extends createZodDto(UpdateSeoSyncSettingsSchema) {}
class SyncDto extends createZodDto(SeoSistrixSyncSchema) {}
class PlatformSistrixDto extends createZodDto(SetProjectPlatformSistrixSchema) {}
class CreateCompetitorDto extends createZodDto(CreateSeoCompetitorSchema) {}
class UpdateCompetitorDto extends createZodDto(UpdateSeoCompetitorSchema) {}
class AddKeywordsDto extends createZodDto(AddSeoProjectKeywordsSchema) {}
class UpdateKeywordDto extends createZodDto(UpdateSeoProjectKeywordSchema) {}

/**
 * Vuelta del OAuth de SISTRIX. Pública (la abre el navegador del super admin
 * al volver de SISTRIX), pero solo vale con un `state` firmado, de un solo uso
 * y sin caducar que se creó al pulsar «Conectar SISTRIX».
 */
@Public()
@Controller('admin/seo/sistrix')
export class SistrixCallbackController {
  constructor(private readonly oauth: SistrixOAuthService) {}

  @Get('callback')
  @ThrottleLogin()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.oauth.callback({ code, state, error });
    res.redirect(302, target);
  }
}

/**
 * Panel admin → SEO → Integraciones (SISTRIX) y los datos de SISTRIX de cada
 * proyecto. Leer: cualquier super admin; cambiar o lanzar consultas: el rol
 * superadmin. Ningún token ni clave sale de aquí.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo')
export class AdminSeoSistrixController {
  constructor(
    private readonly sistrix: SeoSistrixService,
    private readonly data: SeoSistrixDataService,
    private readonly oauth: SistrixOAuthService,
  ) {}

  // ----------------------------------------------------------- integraciones

  @Get('sistrix')
  integrations(): Promise<SeoSistrixIntegrationsDto> {
    return this.sistrix.integrations();
  }

  @Post('sistrix/connect')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sistrix_connect_started')
  connect(@CurrentSuperAdmin('sub') superAdminId: string): Promise<{ authorizationUrl: string }> {
    return this.oauth.start(superAdminId);
  }

  @Post('sistrix/test')
  @RequireSuperadmin()
  test(@CurrentSuperAdmin('sub') superAdminId: string): Promise<SeoSistrixTestResultDto> {
    return this.sistrix.testMcp(superAdminId);
  }

  @Post('sistrix/tools/refresh')
  @RequireSuperadmin()
  refreshTools(): Promise<SeoSistrixIntegrationsDto> {
    return this.sistrix.refreshTools();
  }

  @Delete('sistrix/connection')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sistrix_disconnected')
  async disconnect(): Promise<SeoSistrixIntegrationsDto> {
    await this.oauth.disconnect();
    return this.sistrix.integrations();
  }

  @Put('sistrix/api')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sistrix_api_updated')
  updateApi(@Body() body: UpdateApiDto): Promise<SeoSistrixApiDto> {
    return this.sistrix.updateApi(null, body);
  }

  @Post('sistrix/api/test')
  @RequireSuperadmin()
  testApi(): Promise<SeoSistrixTestResultDto> {
    return this.sistrix.testApi(null);
  }

  /** «Continuar por API»: gasta créditos hasta que el MCP se reanude. */
  @Post('sistrix/api/authorize')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sistrix_api_authorized')
  authorize(@CurrentSuperAdmin('sub') superAdminId: string): Promise<SeoSistrixIntegrationsDto> {
    return this.sistrix.authorizeApi(superAdminId);
  }

  @Delete('sistrix/api/authorize')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sistrix_api_authorization_revoked')
  revoke(): Promise<SeoSistrixIntegrationsDto> {
    return this.sistrix.revokeApiAuthorization();
  }

  @Put('sistrix/settings')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sistrix_settings_updated')
  settings(@Body() body: UpdateSettingsDto): Promise<SeoSyncSettingsDto> {
    return this.sistrix.updateSettings(null, body);
  }

  @Get('sistrix/requests')
  requests(
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
    @Query('provider') provider?: string,
    @Query('projectId', new ParseUUIDPipe({ optional: true })) projectId?: string,
  ): Promise<SeoSistrixRequestsPageDto> {
    return this.sistrix.requests({ pool: null, cursor, status, provider, projectId });
  }

  @Post('sistrix/runs/:runId/cancel')
  @RequireSuperadmin()
  cancelRun(@Param('runId', ParseUUIDPipe) runId: string): Promise<SeoSistrixRunDto> {
    return this.sistrix.cancelRun(null, runId);
  }

  // ----------------------------------------------------- por proyecto

  @Get('projects/:id/sistrix')
  workspace(@Param('id', ParseUUIDPipe) id: string): Promise<SeoSistrixWorkspaceDto> {
    return this.sistrix.workspace(undefined, id);
  }

  /** En un proyecto de tenant: usar la conexión de SISTRIX de la plataforma. */
  @Patch('projects/:id/sistrix-platform')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sistrix_platform_toggled')
  platform(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PlatformSistrixDto,
  ): Promise<SeoSistrixWorkspaceDto> {
    return this.sistrix.setPlatformSistrix(id, body.usePlatformSistrix);
  }

  @Post('projects/:id/sistrix/sync')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sistrix_sync_started')
  syncNow(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SyncDto,
    @CurrentSuperAdmin('sub') superAdminId: string,
  ): Promise<SeoSistrixRunDto> {
    return this.sistrix.syncNow(null, id, body.dataType, { superAdminId });
  }

  @Get('projects/:id/competitors')
  competitors(@Param('id', ParseUUIDPipe) id: string): Promise<SeoCompetitorDto[]> {
    return this.data.competitors(undefined, id);
  }

  @Post('projects/:id/competitors')
  @RequireSuperadmin()
  addCompetitor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateCompetitorDto,
  ): Promise<SeoCompetitorDto[]> {
    return this.data.addCompetitor(null, id, body);
  }

  @Patch('projects/:id/competitors/:competitorId')
  @RequireSuperadmin()
  updateCompetitor(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('competitorId', ParseUUIDPipe) competitorId: string,
    @Body() body: UpdateCompetitorDto,
  ): Promise<SeoCompetitorDto[]> {
    return this.data.updateCompetitor(null, id, competitorId, body);
  }

  @Delete('projects/:id/competitors/:competitorId')
  @RequireSuperadmin()
  removeCompetitor(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('competitorId', ParseUUIDPipe) competitorId: string,
  ): Promise<SeoCompetitorDto[]> {
    return this.data.removeCompetitor(null, id, competitorId);
  }

  @Get('projects/:id/visibility')
  visibility(@Param('id', ParseUUIDPipe) id: string): Promise<SeoVisibilitySeriesDto[]> {
    return this.data.visibility(undefined, id);
  }

  @Get('projects/:id/domain-keywords')
  domainKeywords(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('domain') domain: string,
  ): Promise<SeoDomainKeywordsDto> {
    return this.data.domainKeywords(undefined, id, (domain ?? '').toLowerCase());
  }

  @Get('projects/:id/domain-keywords/history')
  domainKeywordHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('domain') domain: string,
    @Query('keyword') keyword: string,
  ): Promise<SeoDomainKeywordHistoryDto> {
    return this.data.domainKeywordHistory(
      undefined,
      id,
      (domain ?? '').toLowerCase(),
      keyword ?? '',
    );
  }

  @Get('projects/:id/keywords')
  keywords(@Param('id', ParseUUIDPipe) id: string): Promise<SeoProjectKeywordDto[]> {
    return this.data.keywords(undefined, id);
  }

  @Post('projects/:id/keywords')
  @RequireSuperadmin()
  addKeywords(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddKeywordsDto,
  ): Promise<SeoProjectKeywordDto[]> {
    return this.data.addKeywords(null, id, body);
  }

  @Patch('projects/:id/keywords/:keywordId')
  @RequireSuperadmin()
  updateKeyword(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('keywordId', ParseUUIDPipe) keywordId: string,
    @Body() body: UpdateKeywordDto,
  ): Promise<SeoProjectKeywordDto[]> {
    return this.data.updateKeyword(null, id, keywordId, body);
  }

  @Delete('projects/:id/keywords/:keywordId')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  removeKeyword(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('keywordId', ParseUUIDPipe) keywordId: string,
  ): Promise<SeoProjectKeywordDto[]> {
    return this.data.removeKeyword(null, id, keywordId);
  }

  @Get('projects/:id/keywords/:keywordId/serp')
  serp(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('keywordId', ParseUUIDPipe) keywordId: string,
  ): Promise<SeoSerpDto> {
    return this.data.serp(undefined, id, keywordId);
  }

  @Get('projects/:id/opportunities')
  opportunities(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('kind') kind?: string,
  ): Promise<SeoOpportunitiesDto> {
    return this.data.opportunities(undefined, id, kind === 'idea' ? 'idea' : 'opportunity');
  }

  @Get('projects/:id/backlinks')
  backlinks(@Param('id', ParseUUIDPipe) id: string): Promise<SeoBacklinksDto> {
    return this.data.backlinks(undefined, id);
  }

  @Get('projects/:id/ai-visibility')
  aiVisibility(@Param('id', ParseUUIDPipe) id: string): Promise<SeoAiVisibilityRowDto[]> {
    return this.data.aiVisibility(undefined, id);
  }
}

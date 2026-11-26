import {
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
  AddSeoProjectKeywordsSchema,
  CreateSeoCompetitorSchema,
  SeoSistrixSyncSchema,
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
  type SeoSistrixRunDto,
  type SeoSistrixTestResultDto,
  type SeoSistrixWorkspaceDto,
  type SeoSyncSettingsDto,
  type SeoTenantSistrixDto,
  type SeoVisibilitySeriesDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { SeoProjectsService } from '../seo-projects.service';

import { SeoSistrixDataService } from './seo-sistrix-data.service';
import { SeoSistrixService } from './seo-sistrix.service';

class UpdateApiDto extends createZodDto(UpdateSistrixApiSettingsSchema) {}
class UpdateSettingsDto extends createZodDto(UpdateSeoSyncSettingsSchema) {}
class SyncDto extends createZodDto(SeoSistrixSyncSchema) {}
class CreateCompetitorDto extends createZodDto(CreateSeoCompetitorSchema) {}
class UpdateCompetitorDto extends createZodDto(UpdateSeoCompetitorSchema) {}
class AddKeywordsDto extends createZodDto(AddSeoProjectKeywordsSchema) {}
class UpdateKeywordDto extends createZodDto(UpdateSeoProjectKeywordSchema) {}

/**
 * SISTRIX en SEO Avanzado del tenant: su clave de API (cifrada, nunca vuelve),
 * su presupuesto y los datos de su proyecto (competidores, palabras, resultados
 * de Google, oportunidades, enlaces y visibilidad en IA). Sin clave, solo
 * tiene lo de Search Console. Ver con `analytics:read`; configurar y lanzar
 * consultas con `settings:manage`.
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced')
export class SeoAdvancedSistrixController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly sistrix: SeoSistrixService,
    private readonly data: SeoSistrixDataService,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  @RequirePermission('analytics:read')
  @Get('sistrix')
  async workspace(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ workspace: SeoSistrixWorkspaceDto | null; settings: SeoTenantSistrixDto }> {
    const settings = await this.sistrix.tenantSettings(user.tenantId);
    let workspace: SeoSistrixWorkspaceDto | null = null;
    try {
      workspace = await this.sistrix.workspace(user.tenantId, await this.projectId(user));
    } catch {
      workspace = null;
    }
    return { workspace, settings };
  }

  @RequirePermission('settings:manage')
  @Put('sistrix/api')
  updateApi(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateApiDto,
  ): Promise<SeoSistrixApiDto> {
    return this.sistrix.updateApi(user.tenantId, body);
  }

  @RequirePermission('settings:manage')
  @Post('sistrix/api/test')
  testApi(@CurrentUser() user: AuthenticatedUser): Promise<SeoSistrixTestResultDto> {
    return this.sistrix.testApi(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Put('sistrix/settings')
  async settings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateSettingsDto,
  ): Promise<SeoSyncSettingsDto> {
    // El ritmo de las consultas es suyo solo si usa su propia clave.
    const project = await this.sistrix.project(user.tenantId, await this.projectId(user));
    if (project.usePlatformSistrix) {
      throw new BadRequestException({
        code: 'seo_using_platform',
        message: 'Usas la conexión de SISTRIX de la plataforma: el ritmo lo decide la plataforma.',
      });
    }
    return this.sistrix.updateSettings(user.tenantId, body);
  }

  @RequirePermission('settings:manage')
  @Post('sistrix/sync')
  async syncNow(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SyncDto,
  ): Promise<SeoSistrixRunDto> {
    return this.sistrix.syncNow(user.tenantId, await this.projectId(user), body.dataType, {
      userId: user.sub,
    });
  }

  @RequirePermission('settings:manage')
  @Post('sistrix/runs/:runId/cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<SeoSistrixRunDto> {
    return this.sistrix.cancelRun(user.tenantId, runId);
  }

  // ------------------------------------------------------------- datos

  @RequirePermission('analytics:read')
  @Get('competitors')
  async competitors(@CurrentUser() user: AuthenticatedUser): Promise<SeoCompetitorDto[]> {
    return this.data.competitors(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Post('competitors')
  async addCompetitor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCompetitorDto,
  ): Promise<SeoCompetitorDto[]> {
    return this.data.addCompetitor(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('settings:manage')
  @Patch('competitors/:competitorId')
  async updateCompetitor(
    @CurrentUser() user: AuthenticatedUser,
    @Param('competitorId', ParseUUIDPipe) competitorId: string,
    @Body() body: UpdateCompetitorDto,
  ): Promise<SeoCompetitorDto[]> {
    return this.data.updateCompetitor(
      user.tenantId,
      await this.projectId(user),
      competitorId,
      body,
    );
  }

  @RequirePermission('settings:manage')
  @Delete('competitors/:competitorId')
  async removeCompetitor(
    @CurrentUser() user: AuthenticatedUser,
    @Param('competitorId', ParseUUIDPipe) competitorId: string,
  ): Promise<SeoCompetitorDto[]> {
    return this.data.removeCompetitor(user.tenantId, await this.projectId(user), competitorId);
  }

  @RequirePermission('analytics:read')
  @Get('visibility')
  async visibility(@CurrentUser() user: AuthenticatedUser): Promise<SeoVisibilitySeriesDto[]> {
    return this.data.visibility(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('domain-keywords')
  async domainKeywords(
    @CurrentUser() user: AuthenticatedUser,
    @Query('domain') domain: string,
  ): Promise<SeoDomainKeywordsDto> {
    return this.data.domainKeywords(
      user.tenantId,
      await this.projectId(user),
      (domain ?? '').toLowerCase(),
    );
  }

  @RequirePermission('analytics:read')
  @Get('domain-keywords/history')
  async domainKeywordHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query('domain') domain: string,
    @Query('keyword') keyword: string,
  ): Promise<SeoDomainKeywordHistoryDto> {
    return this.data.domainKeywordHistory(
      user.tenantId,
      await this.projectId(user),
      (domain ?? '').toLowerCase(),
      keyword ?? '',
    );
  }

  @RequirePermission('analytics:read')
  @Get('keywords')
  async keywords(@CurrentUser() user: AuthenticatedUser): Promise<SeoProjectKeywordDto[]> {
    return this.data.keywords(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Post('keywords')
  async addKeywords(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: AddKeywordsDto,
  ): Promise<SeoProjectKeywordDto[]> {
    return this.data.addKeywords(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('settings:manage')
  @Patch('keywords/:keywordId')
  async updateKeyword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('keywordId', ParseUUIDPipe) keywordId: string,
    @Body() body: UpdateKeywordDto,
  ): Promise<SeoProjectKeywordDto[]> {
    return this.data.updateKeyword(user.tenantId, await this.projectId(user), keywordId, body);
  }

  @RequirePermission('settings:manage')
  @Delete('keywords/:keywordId')
  @HttpCode(HttpStatus.OK)
  async removeKeyword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('keywordId', ParseUUIDPipe) keywordId: string,
  ): Promise<SeoProjectKeywordDto[]> {
    return this.data.removeKeyword(user.tenantId, await this.projectId(user), keywordId);
  }

  @RequirePermission('analytics:read')
  @Get('keywords/:keywordId/serp')
  async serp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('keywordId', ParseUUIDPipe) keywordId: string,
  ): Promise<SeoSerpDto> {
    return this.data.serp(user.tenantId, await this.projectId(user), keywordId);
  }

  @RequirePermission('analytics:read')
  @Get('opportunities')
  async opportunities(
    @CurrentUser() user: AuthenticatedUser,
    @Query('kind') kind?: string,
  ): Promise<SeoOpportunitiesDto> {
    return this.data.opportunities(
      user.tenantId,
      await this.projectId(user),
      kind === 'idea' ? 'idea' : 'opportunity',
    );
  }

  @RequirePermission('analytics:read')
  @Get('backlinks')
  async backlinks(@CurrentUser() user: AuthenticatedUser): Promise<SeoBacklinksDto> {
    return this.data.backlinks(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('ai-visibility')
  async aiVisibility(@CurrentUser() user: AuthenticatedUser): Promise<SeoAiVisibilityRowDto[]> {
    return this.data.aiVisibility(user.tenantId, await this.projectId(user));
  }
}

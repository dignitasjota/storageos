import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  SeoKeywordImportSchema,
  UpdateSeoDiagnosticSchema,
  UpdateSeoDiagnosticSettingsSchema,
  type SeoCannibalizationDto,
  type SeoCannibalizationSummaryDto,
  type SeoDiagnosticListDto,
  type SeoDiagnosticSettingsDto,
  type SeoDiagnosticsRecalcDto,
  type SeoIndexFindingDto,
  type SeoIndexSummaryDto,
  type SeoKeywordCandidatesDto,
  type SeoKeywordImportPreviewDto,
  type SeoKeywordImportResultDto,
  type SeoSitemapsDto,
  type SeoTrackedKeywordDetailDto,
  type SeoTrackedKeywordsDto,
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
import { RequireSuperadmin } from '../../admin/require-superadmin.decorator';
import { SeoProjectsService } from '../seo-projects.service';

import {
  SeoDiagnosticsService,
  parseSeoCandidateQuery,
  parseSeoDiagnosticQuery,
  parseSeoTrackedQuery,
} from './seo-diagnostics.service';

class UpdateDiagnosticDto extends createZodDto(UpdateSeoDiagnosticSchema) {}
class UpdateSettingsDto extends createZodDto(UpdateSeoDiagnosticSettingsSchema) {}
class KeywordImportDto extends createZodDto(SeoKeywordImportSchema) {}

type Q = Record<string, string | undefined>;

/**
 * Diagnóstico del proyecto del tenant: palabras seguidas (evolución, URL
 * objetivo, alta desde Search Console y desde CSV/Excel), canibalización e
 * indexación. Ver con `analytics:read`; cambiar estado, notas, ajustes,
 * importar y recalcular con `settings:manage`.
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced/diagnostics')
export class SeoAdvancedDiagnosticsController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly diagnostics: SeoDiagnosticsService,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  @RequirePermission('analytics:read')
  @Get('tracked-keywords')
  async tracked(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: Q,
  ): Promise<SeoTrackedKeywordsDto> {
    return this.diagnostics.trackedKeywords(
      user.tenantId,
      await this.projectId(user),
      parseSeoTrackedQuery(q),
    );
  }

  @RequirePermission('analytics:read')
  @Get('tracked-keywords/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="palabras-seguidas.csv"')
  async trackedCsv(@CurrentUser() user: AuthenticatedUser, @Query() q: Q): Promise<string> {
    return this.diagnostics.trackedKeywordsCsv(
      user.tenantId,
      await this.projectId(user),
      parseSeoTrackedQuery(q),
    );
  }

  @RequirePermission('analytics:read')
  @Get('tracked-keywords/:keywordId')
  async trackedDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('keywordId', ParseUUIDPipe) keywordId: string,
    @Query() q: Q,
  ): Promise<SeoTrackedKeywordDetailDto> {
    return this.diagnostics.trackedKeyword(user.tenantId, await this.projectId(user), keywordId, {
      days: Number(q.days) || undefined,
      domainId: q.domainId || undefined,
    });
  }

  @RequirePermission('analytics:read')
  @Get('keyword-candidates')
  async candidates(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: Q,
  ): Promise<SeoKeywordCandidatesDto> {
    return this.diagnostics.keywordCandidates(
      user.tenantId,
      await this.projectId(user),
      parseSeoCandidateQuery(q),
    );
  }

  @RequirePermission('settings:manage')
  @Post('keyword-import/preview')
  async importPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: KeywordImportDto,
  ): Promise<SeoKeywordImportPreviewDto> {
    return this.diagnostics.importPreview(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('settings:manage')
  @Post('keyword-import')
  async importCommit(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: KeywordImportDto,
  ): Promise<SeoKeywordImportResultDto> {
    return this.diagnostics.importCommit(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('analytics:read')
  @Get('settings')
  async settings(@CurrentUser() user: AuthenticatedUser): Promise<SeoDiagnosticSettingsDto> {
    return this.diagnostics.settings(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Put('settings')
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateSettingsDto,
  ): Promise<SeoDiagnosticSettingsDto> {
    return this.diagnostics.updateSettings(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('settings:manage')
  @Post('recalculate')
  async recalculate(@CurrentUser() user: AuthenticatedUser): Promise<SeoDiagnosticsRecalcDto> {
    return this.diagnostics.recalculate(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('cannibalization')
  async cannibalization(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: Q,
  ): Promise<SeoDiagnosticListDto<SeoCannibalizationDto>> {
    return this.diagnostics.cannibalizations(
      user.tenantId,
      await this.projectId(user),
      parseSeoDiagnosticQuery(q),
    );
  }

  @RequirePermission('analytics:read')
  @Get('cannibalization/summary')
  async cannibalizationSummary(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SeoCannibalizationSummaryDto> {
    return this.diagnostics.cannibalizationSummary(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('cannibalization/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="canibalizacion.csv"')
  async cannibalizationCsv(@CurrentUser() user: AuthenticatedUser, @Query() q: Q): Promise<string> {
    return this.diagnostics.cannibalizationCsv(
      user.tenantId,
      await this.projectId(user),
      parseSeoDiagnosticQuery(q),
    );
  }

  @RequirePermission('settings:manage')
  @Patch('cannibalization/:itemId')
  async updateCannibalization(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: UpdateDiagnosticDto,
  ): Promise<SeoCannibalizationDto> {
    return this.diagnostics.updateCannibalization(
      user.tenantId,
      await this.projectId(user),
      itemId,
      body,
    );
  }

  @RequirePermission('analytics:read')
  @Get('index-findings')
  async index(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: Q,
  ): Promise<SeoDiagnosticListDto<SeoIndexFindingDto>> {
    return this.diagnostics.indexFindings(
      user.tenantId,
      await this.projectId(user),
      parseSeoDiagnosticQuery(q),
    );
  }

  @RequirePermission('analytics:read')
  @Get('index-findings/summary')
  async indexSummary(@CurrentUser() user: AuthenticatedUser): Promise<SeoIndexSummaryDto> {
    return this.diagnostics.indexSummary(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('index-findings/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="indexacion.csv"')
  async indexCsv(@CurrentUser() user: AuthenticatedUser, @Query() q: Q): Promise<string> {
    return this.diagnostics.indexCsv(
      user.tenantId,
      await this.projectId(user),
      parseSeoDiagnosticQuery(q),
    );
  }

  @RequirePermission('analytics:read')
  @Get('index-findings/sitemaps')
  async sitemaps(@CurrentUser() user: AuthenticatedUser): Promise<SeoSitemapsDto> {
    return this.diagnostics.sitemaps(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Patch('index-findings/:itemId')
  async updateIndex(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: UpdateDiagnosticDto,
  ): Promise<SeoIndexFindingDto> {
    return this.diagnostics.updateIndexFinding(
      user.tenantId,
      await this.projectId(user),
      itemId,
      body,
    );
  }
}

/**
 * Diagnóstico de un proyecto en el panel admin. Leer: cualquier super admin
 * (también los proyectos de los tenants); cambiar: el rol superadmin y solo en
 * los proyectos de la plataforma.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id/diagnostics')
export class AdminSeoDiagnosticsController {
  constructor(private readonly diagnostics: SeoDiagnosticsService) {}

  @Get('tracked-keywords')
  tracked(@Param('id', ParseUUIDPipe) id: string, @Query() q: Q): Promise<SeoTrackedKeywordsDto> {
    return this.diagnostics.trackedKeywords(undefined, id, parseSeoTrackedQuery(q));
  }

  @Get('tracked-keywords/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="palabras-seguidas.csv"')
  trackedCsv(@Param('id', ParseUUIDPipe) id: string, @Query() q: Q): Promise<string> {
    return this.diagnostics.trackedKeywordsCsv(undefined, id, parseSeoTrackedQuery(q));
  }

  @Get('tracked-keywords/:keywordId')
  trackedDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('keywordId', ParseUUIDPipe) keywordId: string,
    @Query() q: Q,
  ): Promise<SeoTrackedKeywordDetailDto> {
    return this.diagnostics.trackedKeyword(undefined, id, keywordId, {
      days: Number(q.days) || undefined,
      domainId: q.domainId || undefined,
    });
  }

  @Get('keyword-candidates')
  candidates(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: Q,
  ): Promise<SeoKeywordCandidatesDto> {
    return this.diagnostics.keywordCandidates(undefined, id, parseSeoCandidateQuery(q));
  }

  @Post('keyword-import/preview')
  @RequireSuperadmin()
  importPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: KeywordImportDto,
  ): Promise<SeoKeywordImportPreviewDto> {
    return this.diagnostics.importPreview(null, id, body);
  }

  @Post('keyword-import')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.keywords_imported')
  importCommit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: KeywordImportDto,
  ): Promise<SeoKeywordImportResultDto> {
    return this.diagnostics.importCommit(null, id, body);
  }

  @Get('settings')
  settings(@Param('id', ParseUUIDPipe) id: string): Promise<SeoDiagnosticSettingsDto> {
    return this.diagnostics.settings(undefined, id);
  }

  @Put('settings')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.diagnostic_settings_updated')
  updateSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSettingsDto,
  ): Promise<SeoDiagnosticSettingsDto> {
    return this.diagnostics.updateSettings(null, id, body);
  }

  @Post('recalculate')
  @RequireSuperadmin()
  recalculate(@Param('id', ParseUUIDPipe) id: string): Promise<SeoDiagnosticsRecalcDto> {
    return this.diagnostics.recalculate(null, id);
  }

  @Get('cannibalization')
  cannibalization(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: Q,
  ): Promise<SeoDiagnosticListDto<SeoCannibalizationDto>> {
    return this.diagnostics.cannibalizations(undefined, id, parseSeoDiagnosticQuery(q));
  }

  @Get('cannibalization/summary')
  cannibalizationSummary(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SeoCannibalizationSummaryDto> {
    return this.diagnostics.cannibalizationSummary(undefined, id);
  }

  @Get('cannibalization/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="canibalizacion.csv"')
  cannibalizationCsv(@Param('id', ParseUUIDPipe) id: string, @Query() q: Q): Promise<string> {
    return this.diagnostics.cannibalizationCsv(undefined, id, parseSeoDiagnosticQuery(q));
  }

  @Patch('cannibalization/:itemId')
  @RequireSuperadmin()
  updateCannibalization(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: UpdateDiagnosticDto,
  ): Promise<SeoCannibalizationDto> {
    return this.diagnostics.updateCannibalization(null, id, itemId, body);
  }

  @Get('index-findings')
  index(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: Q,
  ): Promise<SeoDiagnosticListDto<SeoIndexFindingDto>> {
    return this.diagnostics.indexFindings(undefined, id, parseSeoDiagnosticQuery(q));
  }

  @Get('index-findings/summary')
  indexSummary(@Param('id', ParseUUIDPipe) id: string): Promise<SeoIndexSummaryDto> {
    return this.diagnostics.indexSummary(undefined, id);
  }

  @Get('index-findings/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="indexacion.csv"')
  indexCsv(@Param('id', ParseUUIDPipe) id: string, @Query() q: Q): Promise<string> {
    return this.diagnostics.indexCsv(undefined, id, parseSeoDiagnosticQuery(q));
  }

  @Get('index-findings/sitemaps')
  sitemaps(@Param('id', ParseUUIDPipe) id: string): Promise<SeoSitemapsDto> {
    return this.diagnostics.sitemaps(undefined, id);
  }

  @Patch('index-findings/:itemId')
  @RequireSuperadmin()
  updateIndex(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: UpdateDiagnosticDto,
  ): Promise<SeoIndexFindingDto> {
    return this.diagnostics.updateIndexFinding(null, id, itemId, body);
  }
}

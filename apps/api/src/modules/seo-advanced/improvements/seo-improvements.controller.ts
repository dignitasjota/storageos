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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  BatchUpdateSeoKeywordsSchema,
  DismissSeoAnnotationSchema,
  RenameSeoKeywordGroupSchema,
  SEO_SISTRIX_CSV_KINDS,
  SEO_SISTRIX_CSV_MAX_BYTES,
  UpdateSeoLocalAreasSchema,
  type SeoAnnotationProposalsDto,
  type SeoAreasDto,
  type SeoBatchResultDto,
  type SeoBrandSplitDto,
  type SeoCompetitionEvolutionDto,
  type SeoCompetitionGroupsDto,
  type SeoCompetitionMoversDto,
  type SeoOpportunityYearAgoDto,
  type SeoPageDevicesDto,
  type SeoSiteChangeDto,
  type SeoSistrixCsvKind,
  type SeoSistrixCsvPreviewDto,
  type SeoSistrixImportDto,
  type SeoSistrixRequestsPageDto,
} from '@storageos/shared';
import { memoryStorage } from 'multer';

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
import { SeoPanelService } from '../seo-panel.service';
import { SeoProjectsService } from '../seo-projects.service';
import { SeoSistrixService } from '../sistrix/seo-sistrix.service';

import { SeoAnnotationsService } from './seo-annotations.service';
import { SeoCompetitionService } from './seo-competition.service';
import { SeoKeywordBatchService } from './seo-keyword-batch.service';
import { type CsvUpload, SeoSistrixCsvService } from './seo-sistrix-csv.service';
import { SeoYearAgoService } from './seo-year-ago.service';
import { SeoZonesService } from './seo-zones.service';

const UPLOAD = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: SEO_SISTRIX_CSV_MAX_BYTES, files: 1 },
});

type Q = Record<string, string | undefined>;

function parseKind(v: unknown): SeoSistrixCsvKind {
  if (typeof v === 'string' && (SEO_SISTRIX_CSV_KINDS as readonly string[]).includes(v)) {
    return v as SeoSistrixCsvKind;
  }
  throw new BadRequestException({
    code: 'seo_csv_kind_invalid',
    message: 'Elige qué tipo de fichero de SISTRIX es.',
  });
}

function csvParams(body: Record<string, unknown>) {
  return {
    kind: parseKind(body.kind),
    domain: typeof body.domain === 'string' ? body.domain : undefined,
    keyword: typeof body.keyword === 'string' ? body.keyword : undefined,
  };
}

function parse<T>(
  schema: {
    safeParse: (v: unknown) => {
      success: boolean;
      data?: T;
      error?: { issues: { message: string }[] };
    };
  },
  body: unknown,
): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw new BadRequestException({
      code: 'validation_failed',
      message: r.error?.issues[0]?.message ?? 'Datos no válidos.',
    });
  }
  return r.data as T;
}

const pageDevicesQuery = (q: Q) => ({
  ...parsePanelQuery(q),
  onlyWorse: q.onlyWorse === '1' || q.onlyWorse === 'true',
  limit: Number.parseInt(q.limit ?? '', 10) || undefined,
});

/**
 * Mejoras de SEO Avanzado en el tenant (marca, zonas, competencia, anotaciones,
 * CSV de SISTRIX, palabras en lote, móvil y año anterior). Ver con
 * `analytics:read`; cambiar con `settings:manage`.
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced')
export class SeoAdvancedImprovementsController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly panel: SeoPanelService,
    private readonly zones: SeoZonesService,
    private readonly competition: SeoCompetitionService,
    private readonly annotations: SeoAnnotationsService,
    private readonly csv: SeoSistrixCsvService,
    private readonly batch: SeoKeywordBatchService,
    private readonly yearAgo: SeoYearAgoService,
    private readonly sistrix: SeoSistrixService,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  // ----------------------------------------------------- marca y móvil

  @RequirePermission('analytics:read')
  @Get('brand')
  async brand(@CurrentUser() user: AuthenticatedUser, @Query() q: Q): Promise<SeoBrandSplitDto> {
    return this.panel.brandSplit(user.tenantId, await this.projectId(user), parsePanelQuery(q));
  }

  @RequirePermission('analytics:read')
  @Get('pages/devices')
  async pageDevices(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: Q,
  ): Promise<SeoPageDevicesDto> {
    return this.panel.pageDevices(user.tenantId, await this.projectId(user), pageDevicesQuery(q));
  }

  // ------------------------------------------------------------ zonas

  @RequirePermission('analytics:read')
  @Get('areas')
  async areas(@CurrentUser() user: AuthenticatedUser): Promise<SeoAreasDto> {
    return this.zones.get(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Put('areas')
  async setAreas(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<SeoAreasDto> {
    return this.zones.set(
      user.tenantId,
      await this.projectId(user),
      parse(UpdateSeoLocalAreasSchema, body),
    );
  }

  // ------------------------------------------------------ competencia

  @RequirePermission('analytics:read')
  @Get('competition/movers')
  async movers(@CurrentUser() user: AuthenticatedUser): Promise<SeoCompetitionMoversDto> {
    return this.competition.movers(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('competition/groups')
  async groups(@CurrentUser() user: AuthenticatedUser): Promise<SeoCompetitionGroupsDto> {
    return this.competition.groups(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('competition/evolution')
  async evolution(
    @CurrentUser() user: AuthenticatedUser,
    @Query('domain') domain: string | undefined,
    @Query('keywordId', ParseUUIDPipe) projectKeywordId: string,
  ): Promise<SeoCompetitionEvolutionDto> {
    return this.competition.evolution(
      user.tenantId,
      await this.projectId(user),
      domain ?? '',
      projectKeywordId,
    );
  }

  // ----------------------------------------------------- anotaciones

  @RequirePermission('analytics:read')
  @Get('annotations/proposals')
  async proposals(@CurrentUser() user: AuthenticatedUser): Promise<SeoAnnotationProposalsDto> {
    return this.annotations.proposals(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Post('annotations/proposals/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { sourceRef?: string },
  ): Promise<SeoSiteChangeDto> {
    return this.annotations.confirm(
      user.tenantId,
      await this.projectId(user),
      body?.sourceRef ?? '',
      {
        userId: user.sub,
      },
    );
  }

  @RequirePermission('settings:manage')
  @Post('annotations/proposals/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dismiss(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown): Promise<void> {
    await this.annotations.dismiss(
      user.tenantId,
      await this.projectId(user),
      parse(DismissSeoAnnotationSchema, body).sourceRefs,
    );
  }

  // --------------------------------------------- CSV de SISTRIX

  @RequirePermission('analytics:read')
  @Get('sistrix-imports')
  async imports(@CurrentUser() user: AuthenticatedUser): Promise<SeoSistrixImportDto[]> {
    return this.csv.list(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Post('sistrix-imports/preview')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(UPLOAD)
  async previewImport(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: CsvUpload | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<SeoSistrixCsvPreviewDto> {
    return this.csv.preview(user.tenantId, await this.projectId(user), file, csvParams(body));
  }

  @RequirePermission('settings:manage')
  @Post('sistrix-imports')
  @UseInterceptors(UPLOAD)
  async createImport(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: CsvUpload | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<SeoSistrixImportDto> {
    return this.csv.commit(user.tenantId, await this.projectId(user), file, csvParams(body), {
      userId: user.sub,
    });
  }

  @RequirePermission('settings:manage')
  @Delete('sistrix-imports/:importId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeImport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('importId', ParseUUIDPipe) importId: string,
  ): Promise<void> {
    await this.csv.remove(user.tenantId, await this.projectId(user), importId);
  }

  // ------------------------------------------- palabras en lote

  @RequirePermission('settings:manage')
  @Patch('keywords-batch')
  async batchUpdate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<SeoBatchResultDto> {
    return this.batch.update(
      user.tenantId,
      await this.projectId(user),
      parse(BatchUpdateSeoKeywordsSchema, body),
    );
  }

  @RequirePermission('settings:manage')
  @Post('keywords-batch/accept-suggested-urls')
  @HttpCode(HttpStatus.OK)
  async acceptUrls(@CurrentUser() user: AuthenticatedUser): Promise<SeoBatchResultDto> {
    return this.batch.acceptSuggestedUrls(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Post('keyword-groups/rename')
  @HttpCode(HttpStatus.OK)
  async renameGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { from?: string; to?: string },
  ): Promise<SeoBatchResultDto> {
    const { name } = parse(RenameSeoKeywordGroupSchema, { name: body?.to });
    return this.batch.renameGroup(
      user.tenantId,
      await this.projectId(user),
      body?.from ?? '',
      name,
    );
  }

  // ------------------------------------------------ año anterior

  @RequirePermission('analytics:read')
  @Get('opportunities/:opportunityId/year-ago')
  async opportunityYearAgo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
  ): Promise<SeoOpportunityYearAgoDto> {
    return this.yearAgo.forOpportunity(user.tenantId, await this.projectId(user), opportunityId);
  }

  // -------------------------------- SISTRIX: historial para el tenant

  @RequirePermission('analytics:read')
  @Get('sistrix/requests')
  requests(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<SeoSistrixRequestsPageDto> {
    return this.sistrix.requests({
      pool: user.tenantId,
      cursor,
      status,
      provider: undefined,
      projectId: undefined,
    });
  }
}

/** Lo mismo en el panel admin: leer, cualquier super admin; cambiar, superadmin y solo en proyectos de la plataforma. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id')
export class AdminSeoImprovementsController {
  constructor(
    private readonly panel: SeoPanelService,
    private readonly zones: SeoZonesService,
    private readonly competition: SeoCompetitionService,
    private readonly annotations: SeoAnnotationsService,
    private readonly csv: SeoSistrixCsvService,
    private readonly batch: SeoKeywordBatchService,
    private readonly yearAgo: SeoYearAgoService,
  ) {}

  @Get('brand')
  brand(@Param('id', ParseUUIDPipe) id: string, @Query() q: Q): Promise<SeoBrandSplitDto> {
    return this.panel.brandSplit(undefined, id, parsePanelQuery(q));
  }

  @Get('pages/devices')
  pageDevices(@Param('id', ParseUUIDPipe) id: string, @Query() q: Q): Promise<SeoPageDevicesDto> {
    return this.panel.pageDevices(undefined, id, pageDevicesQuery(q));
  }

  @Get('areas')
  areas(@Param('id', ParseUUIDPipe) id: string): Promise<SeoAreasDto> {
    return this.zones.get(undefined, id);
  }

  @Put('areas')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.areas_updated')
  setAreas(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<SeoAreasDto> {
    return this.zones.set(null, id, parse(UpdateSeoLocalAreasSchema, body));
  }

  @Get('competition/movers')
  movers(@Param('id', ParseUUIDPipe) id: string): Promise<SeoCompetitionMoversDto> {
    return this.competition.movers(undefined, id);
  }

  @Get('competition/groups')
  groups(@Param('id', ParseUUIDPipe) id: string): Promise<SeoCompetitionGroupsDto> {
    return this.competition.groups(undefined, id);
  }

  @Get('competition/evolution')
  evolution(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('domain') domain: string | undefined,
    @Query('keywordId', ParseUUIDPipe) projectKeywordId: string,
  ): Promise<SeoCompetitionEvolutionDto> {
    return this.competition.evolution(undefined, id, domain ?? '', projectKeywordId);
  }

  @Get('annotations/proposals')
  proposals(@Param('id', ParseUUIDPipe) id: string): Promise<SeoAnnotationProposalsDto> {
    return this.annotations.proposals(undefined, id);
  }

  @Post('annotations/proposals/confirm')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() body: { sourceRef?: string },
  ): Promise<SeoSiteChangeDto> {
    return this.annotations.confirm(null, id, body?.sourceRef ?? '', { superAdminId });
  }

  @Post('annotations/proposals/dismiss')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async dismiss(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.annotations.dismiss(null, id, parse(DismissSeoAnnotationSchema, body).sourceRefs);
  }

  @Get('sistrix-imports')
  imports(@Param('id', ParseUUIDPipe) id: string): Promise<SeoSistrixImportDto[]> {
    return this.csv.list(undefined, id);
  }

  @Post('sistrix-imports/preview')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(UPLOAD)
  previewImport(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: CsvUpload | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<SeoSistrixCsvPreviewDto> {
    return this.csv.preview(null, id, file, csvParams(body));
  }

  @Post('sistrix-imports')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sistrix_csv_imported')
  @UseInterceptors(UPLOAD)
  createImport(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @UploadedFile() file: CsvUpload | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<SeoSistrixImportDto> {
    return this.csv.commit(null, id, file, csvParams(body), { superAdminId });
  }

  @Delete('sistrix-imports/:importId')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeImport(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('importId', ParseUUIDPipe) importId: string,
  ): Promise<void> {
    await this.csv.remove(null, id, importId);
  }

  @Patch('keywords-batch')
  @RequireSuperadmin()
  batchUpdate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<SeoBatchResultDto> {
    return this.batch.update(null, id, parse(BatchUpdateSeoKeywordsSchema, body));
  }

  @Post('keywords-batch/accept-suggested-urls')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  acceptUrls(@Param('id', ParseUUIDPipe) id: string): Promise<SeoBatchResultDto> {
    return this.batch.acceptSuggestedUrls(null, id);
  }

  @Post('keyword-groups/rename')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  renameGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { from?: string; to?: string },
  ): Promise<SeoBatchResultDto> {
    const { name } = parse(RenameSeoKeywordGroupSchema, { name: body?.to });
    return this.batch.renameGroup(null, id, body?.from ?? '', name);
  }

  @Get('opportunities/:opportunityId/year-ago')
  opportunityYearAgo(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
  ): Promise<SeoOpportunityYearAgoDto> {
    return this.yearAgo.forOpportunity(undefined, id, opportunityId);
  }
}

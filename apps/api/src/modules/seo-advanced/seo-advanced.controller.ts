import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CreateSeoDomainSchema,
  CreateTenantSeoProjectSchema,
  SEO_IMPORT_MAX_BYTES,
  UpdateSeoDomainSchema,
  UpdateSeoProjectSchema,
  type SeoCrossDto,
  type SeoDashboardDto,
  type SeoImportDetailDto,
  type SeoImportDto,
  type SeoImportPreviewDto,
  type SeoProjectDto,
  type SeoSummaryDto,
  type SeoSyncRunDto,
  type SeoTablePageDto,
  type SeoWorkspaceDto,
} from '@storageos/shared';
import { memoryStorage } from 'multer';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import {
  parseCrossDimension,
  parsePanelQuery,
  parseSeoDays,
  parseTableQuery,
  parseUploadDomainId,
} from './seo-days';
import { SeoImportsService, type SeoUploadedFile } from './seo-imports.service';
import { SeoPanelService } from './seo-panel.service';
import { SeoProjectsService } from './seo-projects.service';

const UPLOAD = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: SEO_IMPORT_MAX_BYTES, files: 1 },
});

class CreateProjectDto extends createZodDto(CreateTenantSeoProjectSchema) {}
class UpdateProjectDto extends createZodDto(UpdateSeoProjectSchema) {}
class CreateDomainDto extends createZodDto(CreateSeoDomainSchema) {}
class UpdateDomainDto extends createZodDto(UpdateSeoDomainSchema) {}

/**
 * SEO Avanzado del tenant: su proyecto (uno), sus dominios y las descargas de
 * Search Console. Ver con `analytics:read`; configurar con `settings:manage`.
 * Rutas `/seo-advanced/...` (las de `/seo/...` son de «SEO local»).
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced')
export class SeoAdvancedController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly panel: SeoPanelService,
    private readonly imports: SeoImportsService,
  ) {}

  @RequirePermission('analytics:read')
  @Get()
  workspace(@CurrentUser() user: AuthenticatedUser): Promise<SeoWorkspaceDto> {
    return this.projects.workspace(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Post('project')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateProjectDto,
  ): Promise<SeoProjectDto> {
    return this.projects.create(user.tenantId, body);
  }

  @RequirePermission('settings:manage')
  @Patch('project')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateProjectDto,
  ): Promise<SeoProjectDto> {
    return this.projects.update(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('settings:manage')
  @Post('domains')
  async addDomain(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateDomainDto,
  ): Promise<SeoProjectDto> {
    return this.projects.addDomain(user.tenantId, await this.projectId(user), body, {
      userId: user.sub,
    });
  }

  @RequirePermission('settings:manage')
  @Patch('domains/:domainId')
  async updateDomain(
    @CurrentUser() user: AuthenticatedUser,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: UpdateDomainDto,
  ): Promise<SeoProjectDto> {
    return this.projects.updateDomain(user.tenantId, await this.projectId(user), domainId, body);
  }

  @RequirePermission('settings:manage')
  @Delete('domains/:domainId')
  async removeDomain(
    @CurrentUser() user: AuthenticatedUser,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ): Promise<SeoProjectDto> {
    return this.projects.removeDomain(user.tenantId, await this.projectId(user), domainId);
  }

  @RequirePermission('settings:manage')
  @Post('domains/:domainId/check')
  async check(
    @CurrentUser() user: AuthenticatedUser,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ): Promise<SeoProjectDto> {
    return this.projects.checkDomain(user.tenantId, await this.projectId(user), domainId, {
      userId: user.sub,
    });
  }

  @RequirePermission('settings:manage')
  @Post('domains/:domainId/sync')
  async sync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ): Promise<SeoSyncRunDto> {
    return this.projects.syncDomain(user.tenantId, await this.projectId(user), domainId, {
      userId: user.sub,
    });
  }

  @RequirePermission('analytics:read')
  @Get('runs')
  async runs(@CurrentUser() user: AuthenticatedUser): Promise<SeoSyncRunDto[]> {
    return this.projects.runs(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Post('runs/:runId/cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<SeoSyncRunDto> {
    return this.projects.cancelRun(user.tenantId, runId);
  }

  @RequirePermission('analytics:read')
  @Get('summary')
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
    @Query('domainId', new ParseUUIDPipe({ optional: true })) domainId?: string,
  ): Promise<SeoSummaryDto> {
    return this.projects.summary(user.tenantId, await this.projectId(user), {
      days: parseSeoDays(days),
      domainId,
    });
  }

  // ------------------------------------------------------------------ panel

  @RequirePermission('analytics:read')
  @Get('dashboard')
  async dashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoDashboardDto> {
    return this.panel.dashboard(user.tenantId, await this.projectId(user), parsePanelQuery(query));
  }

  @RequirePermission('analytics:read')
  @Get('queries')
  async queries(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoTablePageDto> {
    return this.panel.table(
      user.tenantId,
      await this.projectId(user),
      'query',
      parseTableQuery(query),
    );
  }

  @RequirePermission('analytics:read')
  @Get('queries/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="busquedas.csv"')
  async queriesCsv(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.panel.tableCsv(
      user.tenantId,
      await this.projectId(user),
      'query',
      parseTableQuery(query),
    );
  }

  @RequirePermission('analytics:read')
  @Get('pages')
  async pages(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoTablePageDto> {
    return this.panel.table(
      user.tenantId,
      await this.projectId(user),
      'page',
      parseTableQuery(query),
    );
  }

  @RequirePermission('analytics:read')
  @Get('pages/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="paginas.csv"')
  async pagesCsv(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.panel.tableCsv(
      user.tenantId,
      await this.projectId(user),
      'page',
      parseTableQuery(query),
    );
  }

  /** Una búsqueda → sus páginas, o una página → sus búsquedas. */
  @RequirePermission('analytics:read')
  @Get('cross')
  async cross(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoCrossDto> {
    return this.panel.cross(
      user.tenantId,
      await this.projectId(user),
      parseCrossDimension(query.dimension),
      (query.value ?? '').slice(0, 2000),
      parsePanelQuery(query),
    );
  }

  // --------------------------------------------------- importar histórico

  @RequirePermission('analytics:read')
  @Get('imports')
  async listImports(@CurrentUser() user: AuthenticatedUser): Promise<SeoImportDto[]> {
    return this.imports.list(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('imports/:importId')
  async importDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('importId', ParseUUIDPipe) importId: string,
  ): Promise<SeoImportDetailDto> {
    return this.imports.detail(user.tenantId, await this.projectId(user), importId);
  }

  /** Lo que haría la importación (no guarda nada). */
  @RequirePermission('settings:manage')
  @Post('imports/preview')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(UPLOAD)
  async previewImport(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: SeoUploadedFile | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<SeoImportPreviewDto> {
    return this.imports.preview(
      user.tenantId,
      await this.projectId(user),
      parseUploadDomainId(body.domainId),
      file,
    );
  }

  @RequirePermission('settings:manage')
  @Post('imports')
  @UseInterceptors(UPLOAD)
  async createImport(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: SeoUploadedFile | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<SeoImportDto> {
    return this.imports.create(
      user.tenantId,
      await this.projectId(user),
      parseUploadDomainId(body.domainId),
      file,
      { userId: user.sub },
    );
  }

  @RequirePermission('settings:manage')
  @Delete('imports/:importId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeImport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('importId', ParseUUIDPipe) importId: string,
  ): Promise<void> {
    await this.imports.remove(user.tenantId, await this.projectId(user), importId);
  }

  /** Su proyecto (404 si aún no lo ha creado). */
  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }
}

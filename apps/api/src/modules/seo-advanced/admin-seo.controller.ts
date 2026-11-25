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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CreateSeoDomainSchema,
  CreateSeoProjectSchema,
  SEO_IMPORT_MAX_BYTES,
  UpdateSeoDomainSchema,
  UpdateSeoProjectSchema,
  type SeoCrossDto,
  type SeoDashboardDto,
  type SeoImportDetailDto,
  type SeoImportDto,
  type SeoImportPreviewDto,
  type SeoProjectOverviewDto,
  type SeoTablePageDto,
  type SeoGscPropertiesDto,
  type SeoProjectDto,
  type SeoSummaryDto,
  type SeoSyncRunDto,
  type SeoTenantProjectRowDto,
} from '@storageos/shared';
import { memoryStorage } from 'multer';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminAudit } from '../admin/admin-audit.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { CurrentSuperAdmin } from '../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

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

class CreateProjectDto extends createZodDto(CreateSeoProjectSchema) {}
class UpdateProjectDto extends createZodDto(UpdateSeoProjectSchema) {}
class CreateDomainDto extends createZodDto(CreateSeoDomainSchema) {}
class UpdateDomainDto extends createZodDto(UpdateSeoDomainSchema) {}

/**
 * Panel admin → SEO. Los proyectos de la plataforma (trasteros.pro): leer,
 * cualquier super admin; cambiar o descargar, el rol superadmin. Los de los
 * tenants se ven en solo lectura.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo')
export class AdminSeoController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly panel: SeoPanelService,
    private readonly imports: SeoImportsService,
  ) {}

  /** Vista global: cada proyecto (plataforma y tenants) con sus últimos 28 días. */
  @Get('overview')
  overview(): Promise<SeoProjectOverviewDto[]> {
    return this.panel.overview();
  }

  @Get('projects')
  list(): Promise<SeoProjectDto[]> {
    return this.projects.list(null);
  }

  @Post('projects')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.project_created')
  create(@Body() body: CreateProjectDto): Promise<SeoProjectDto> {
    return this.projects.create(null, body);
  }

  /** Propiedades a las que la cuenta de servicio tiene acceso. */
  @Get('properties')
  properties(): Promise<SeoGscPropertiesDto> {
    return this.projects.properties();
  }

  /** Proyectos de los tenants (solo lectura). */
  @Get('tenant-projects')
  tenantProjects(): Promise<SeoTenantProjectRowDto[]> {
    return this.projects.tenantProjects();
  }

  /** Cualquier proyecto: de la plataforma o, en lectura, de un tenant. */
  @Get('projects/:id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<SeoProjectDto> {
    return this.projects.getAny(id);
  }

  @Patch('projects/:id')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.project_updated')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateProjectDto,
  ): Promise<SeoProjectDto> {
    return this.projects.update(null, id, body);
  }

  @Delete('projects/:id')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.project_deleted')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.projects.remove(null, id);
  }

  @Post('projects/:id/domains')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.domain_added')
  addDomain(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateDomainDto,
    @CurrentSuperAdmin('sub') superAdminId: string,
  ): Promise<SeoProjectDto> {
    return this.projects.addDomain(null, id, body, { superAdminId });
  }

  @Patch('projects/:id/domains/:domainId')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.domain_updated')
  updateDomain(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: UpdateDomainDto,
  ): Promise<SeoProjectDto> {
    return this.projects.updateDomain(null, id, domainId, body);
  }

  @Delete('projects/:id/domains/:domainId')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.domain_removed')
  removeDomain(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ): Promise<SeoProjectDto> {
    return this.projects.removeDomain(null, id, domainId);
  }

  @Post('projects/:id/domains/:domainId/check')
  @RequireSuperadmin()
  checkDomain(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
  ): Promise<SeoProjectDto> {
    return this.projects.checkDomain(null, id, domainId, { superAdminId });
  }

  @Post('projects/:id/domains/:domainId/sync')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sync_started')
  sync(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
  ): Promise<SeoSyncRunDto> {
    return this.projects.syncDomain(null, id, domainId, { superAdminId });
  }

  @Get('projects/:id/runs')
  runs(@Param('id', ParseUUIDPipe) id: string): Promise<SeoSyncRunDto[]> {
    return this.projects.runs(undefined, id);
  }

  @Post('runs/:runId/cancel')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.sync_cancelled')
  cancel(@Param('runId', ParseUUIDPipe) runId: string): Promise<SeoSyncRunDto> {
    return this.projects.cancelRun(null, runId);
  }

  @Get('projects/:id/summary')
  summary(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('days') days?: string,
    @Query('domainId', new ParseUUIDPipe({ optional: true })) domainId?: string,
  ): Promise<SeoSummaryDto> {
    return this.projects.summary(undefined, id, { days: parseSeoDays(days), domainId });
  }

  // ------------------------------------------------------------------ panel

  @Get('projects/:id/dashboard')
  dashboard(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoDashboardDto> {
    return this.panel.dashboard(undefined, id, parsePanelQuery(query));
  }

  @Get('projects/:id/queries')
  queries(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoTablePageDto> {
    return this.panel.table(undefined, id, 'query', parseTableQuery(query));
  }

  @Get('projects/:id/queries/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="busquedas.csv"')
  queriesCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.panel.tableCsv(undefined, id, 'query', parseTableQuery(query));
  }

  @Get('projects/:id/pages')
  pages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoTablePageDto> {
    return this.panel.table(undefined, id, 'page', parseTableQuery(query));
  }

  @Get('projects/:id/pages/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="paginas.csv"')
  pagesCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.panel.tableCsv(undefined, id, 'page', parseTableQuery(query));
  }

  @Get('projects/:id/cross')
  cross(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoCrossDto> {
    return this.panel.cross(
      undefined,
      id,
      parseCrossDimension(query.dimension),
      (query.value ?? '').slice(0, 2000),
      parsePanelQuery(query),
    );
  }

  // --------------------------------------------------- importar histórico

  @Get('projects/:id/imports')
  listImports(@Param('id', ParseUUIDPipe) id: string): Promise<SeoImportDto[]> {
    return this.imports.list(undefined, id);
  }

  @Get('projects/:id/imports/:importId')
  importDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('importId', ParseUUIDPipe) importId: string,
  ): Promise<SeoImportDetailDto> {
    return this.imports.detail(undefined, id, importId);
  }

  /** Solo en los proyectos de la plataforma (los de los tenants, en lectura). */
  @Post('projects/:id/imports/preview')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(UPLOAD)
  previewImport(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: SeoUploadedFile | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<SeoImportPreviewDto> {
    return this.imports.preview(null, id, parseUploadDomainId(body.domainId), file);
  }

  @Post('projects/:id/imports')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.import_created')
  @UseInterceptors(UPLOAD)
  createImport(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: SeoUploadedFile | undefined,
    @Body() body: Record<string, unknown>,
    @CurrentSuperAdmin('sub') superAdminId: string,
  ): Promise<SeoImportDto> {
    return this.imports.create(null, id, parseUploadDomainId(body.domainId), file, {
      superAdminId,
    });
  }

  @Delete('projects/:id/imports/:importId')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.import_deleted')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeImport(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('importId', ParseUUIDPipe) importId: string,
  ): Promise<void> {
    await this.imports.remove(null, id, importId);
  }
}

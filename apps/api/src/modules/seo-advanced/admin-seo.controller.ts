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
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateSeoDomainSchema,
  CreateSeoProjectSchema,
  UpdateSeoDomainSchema,
  UpdateSeoProjectSchema,
  type SeoGscPropertiesDto,
  type SeoProjectDto,
  type SeoSummaryDto,
  type SeoSyncRunDto,
  type SeoTenantProjectRowDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminAudit } from '../admin/admin-audit.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { CurrentSuperAdmin } from '../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

import { parseSeoDays } from './seo-days';
import { SeoProjectsService } from './seo-projects.service';

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
  constructor(private readonly projects: SeoProjectsService) {}

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
}

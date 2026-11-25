import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateSeoDomainSchema,
  CreateTenantSeoProjectSchema,
  UpdateSeoDomainSchema,
  UpdateSeoProjectSchema,
  type SeoProjectDto,
  type SeoSummaryDto,
  type SeoSyncRunDto,
  type SeoWorkspaceDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { parseSeoDays } from './seo-days';
import { SeoProjectsService } from './seo-projects.service';

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
  constructor(private readonly projects: SeoProjectsService) {}

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

  /** Su proyecto (404 si aún no lo ha creado). */
  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }
}

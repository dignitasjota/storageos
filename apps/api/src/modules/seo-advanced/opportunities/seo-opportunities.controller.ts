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
  UpdateSeoOpportunitySchema,
  UpdateSeoOpportunitySettingsSchema,
  type SeoOpportunityAssigneeDto,
  type SeoOpportunityDetailDto,
  type SeoOpportunityPageDto,
  type SeoOpportunityRecalcDto,
  type SeoOpportunitySettingsDto,
  type SeoOpportunitySummaryDto,
  type SeoScoredOpportunityDto,
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

import { SeoOpportunitiesService, parseSeoOpportunityQuery } from './seo-opportunities.service';

class UpdateOpportunityDto extends createZodDto(UpdateSeoOpportunitySchema) {}
class UpdateSettingsDto extends createZodDto(UpdateSeoOpportunitySettingsSchema) {}

/**
 * Oportunidades del proyecto del tenant (motor propio con puntuación). Ver con
 * `analytics:read`; cambiar estado, asignar, recalcular y tocar los pesos con
 * `settings:manage`.
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced/opportunity-engine')
export class SeoAdvancedOpportunitiesController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly opportunities: SeoOpportunitiesService,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  @RequirePermission('analytics:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoOpportunityPageDto> {
    return this.opportunities.list(
      user.tenantId,
      await this.projectId(user),
      parseSeoOpportunityQuery(query),
    );
  }

  @RequirePermission('analytics:read')
  @Get('summary')
  async summary(@CurrentUser() user: AuthenticatedUser): Promise<SeoOpportunitySummaryDto> {
    return this.opportunities.summary(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="oportunidades.csv"')
  async csv(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.opportunities.csv(
      user.tenantId,
      await this.projectId(user),
      parseSeoOpportunityQuery(query),
    );
  }

  @RequirePermission('analytics:read')
  @Get('settings')
  async settings(@CurrentUser() user: AuthenticatedUser): Promise<SeoOpportunitySettingsDto> {
    return this.opportunities.settings(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Put('settings')
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateSettingsDto,
  ): Promise<SeoOpportunitySettingsDto> {
    return this.opportunities.updateSettings(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('analytics:read')
  @Get('assignees')
  async assignees(@CurrentUser() user: AuthenticatedUser): Promise<SeoOpportunityAssigneeDto[]> {
    return this.opportunities.assignees(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Post('recalculate')
  async recalculate(@CurrentUser() user: AuthenticatedUser): Promise<SeoOpportunityRecalcDto> {
    return this.opportunities.recalculate(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get(':opportunityId')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
  ): Promise<SeoOpportunityDetailDto> {
    return this.opportunities.detail(user.tenantId, await this.projectId(user), opportunityId);
  }

  @RequirePermission('settings:manage')
  @Patch(':opportunityId')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
    @Body() body: UpdateOpportunityDto,
  ): Promise<SeoScoredOpportunityDto> {
    return this.opportunities.update(
      user.tenantId,
      await this.projectId(user),
      opportunityId,
      body,
    );
  }
}

/**
 * Oportunidades de un proyecto en el panel admin. Leer: cualquier super admin
 * (también los proyectos de los tenants); cambiar: el rol superadmin y solo en
 * los proyectos de la plataforma.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id/opportunity-engine')
export class AdminSeoOpportunitiesController {
  constructor(private readonly opportunities: SeoOpportunitiesService) {}

  @Get()
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoOpportunityPageDto> {
    return this.opportunities.list(undefined, id, parseSeoOpportunityQuery(query));
  }

  @Get('summary')
  summary(@Param('id', ParseUUIDPipe) id: string): Promise<SeoOpportunitySummaryDto> {
    return this.opportunities.summary(undefined, id);
  }

  @Get('csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="oportunidades.csv"')
  csv(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.opportunities.csv(undefined, id, parseSeoOpportunityQuery(query));
  }

  @Get('settings')
  settings(@Param('id', ParseUUIDPipe) id: string): Promise<SeoOpportunitySettingsDto> {
    return this.opportunities.settings(undefined, id);
  }

  @Put('settings')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.opportunity_settings_updated')
  updateSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSettingsDto,
  ): Promise<SeoOpportunitySettingsDto> {
    return this.opportunities.updateSettings(null, id, body);
  }

  @Get('assignees')
  assignees(@Param('id', ParseUUIDPipe) id: string): Promise<SeoOpportunityAssigneeDto[]> {
    return this.opportunities.assignees(undefined, id);
  }

  @Post('recalculate')
  @RequireSuperadmin()
  recalculate(@Param('id', ParseUUIDPipe) id: string): Promise<SeoOpportunityRecalcDto> {
    return this.opportunities.recalculate(null, id);
  }

  @Get(':opportunityId')
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
  ): Promise<SeoOpportunityDetailDto> {
    return this.opportunities.detail(undefined, id, opportunityId);
  }

  @Patch(':opportunityId')
  @RequireSuperadmin()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
    @Body() body: UpdateOpportunityDto,
  ): Promise<SeoScoredOpportunityDto> {
    return this.opportunities.update(null, id, opportunityId, body);
  }
}

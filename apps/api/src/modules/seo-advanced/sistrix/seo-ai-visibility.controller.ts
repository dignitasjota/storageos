import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import {
  UpdateSeoAiTrackedPromptsSchema,
  type SeoAiVisibilityReportDto,
  type SeoAiVisibilitySettings,
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

import { SeoAiVisibilityService } from './seo-ai-visibility.service';

class TrackedPromptsDto extends createZodDto(UpdateSeoAiTrackedPromptsSchema) {}

/**
 * Visibilidad en buscadores de IA del proyecto del tenant (PR 12). Ver con
 * `analytics:read`; elegir los prompts que se siguen con `settings:manage`.
 * Las consultas a SISTRIX se lanzan como el resto («Visibilidad en IA» en
 * `POST /seo-advanced/sistrix/sync`).
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced/ai-visibility')
export class SeoAdvancedAiVisibilityController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly ai: SeoAiVisibilityService,
  ) {}

  @RequirePermission('analytics:read')
  @Get('report')
  async report(@CurrentUser() user: AuthenticatedUser): Promise<SeoAiVisibilityReportDto> {
    return this.ai.report(user.tenantId, await this.projects.tenantProjectId(user.tenantId));
  }

  @RequirePermission('settings:manage')
  @Put('tracked-prompts')
  async tracked(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TrackedPromptsDto,
  ): Promise<SeoAiVisibilitySettings> {
    return this.ai.setTrackedPrompts(
      user.tenantId,
      await this.projects.tenantProjectId(user.tenantId),
      body,
    );
  }
}

/** Lo mismo en el panel admin (cambiar: el rol superadmin y solo en la plataforma). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id/ai-visibility')
export class AdminSeoAiVisibilityController {
  constructor(private readonly ai: SeoAiVisibilityService) {}

  @Get('report')
  report(@Param('id', ParseUUIDPipe) id: string): Promise<SeoAiVisibilityReportDto> {
    return this.ai.report(undefined, id);
  }

  @Put('tracked-prompts')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.ai_prompts_changed')
  tracked(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TrackedPromptsDto,
  ): Promise<SeoAiVisibilitySettings> {
    return this.ai.setTrackedPrompts(null, id, body);
  }
}

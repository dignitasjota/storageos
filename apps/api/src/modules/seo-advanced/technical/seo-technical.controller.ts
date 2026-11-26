import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  InspectSeoUrlSchema,
  RunSeoPageSpeedSchema,
  UpdateSeoTechnicalSettingsSchema,
  type SeoInspectResultDto,
  type SeoInspectionHistoryDto,
  type SeoInspectionsDto,
  type SeoPageSpeedDto,
  type SeoPageSpeedHistoryDto,
  type SeoPageSpeedRunDto,
  type SeoPageSpeedStrategy,
  type SeoTechnicalSettings,
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
import { CurrentSuperAdmin } from '../../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../../admin/require-superadmin.decorator';
import { SeoProjectsService } from '../seo-projects.service';

import { SeoInspectionService } from './seo-inspection.service';
import { SeoPageSpeedService } from './seo-pagespeed.service';

class InspectDto extends createZodDto(InspectSeoUrlSchema) {}
class PageSpeedDto extends createZodDto(RunSeoPageSpeedSchema) {}
class TechnicalSettingsDto extends createZodDto(UpdateSeoTechnicalSettingsSchema) {}

/** La URL de las consultas de historial (obligatoria y con un tamaño razonable). */
function urlParam(url: string | undefined): string {
  const u = (url ?? '').trim();
  if (!u || u.length > 2000) {
    throw new BadRequestException({ code: 'invalid_url', message: 'Falta la URL.' });
  }
  return u;
}
const strategyOf = (v: string | undefined): SeoPageSpeedStrategy =>
  v === 'desktop' ? 'desktop' : 'mobile';

/**
 * Inspección de URL de Google y PageSpeed del proyecto del tenant (PR 9). Ver
 * con `analytics:read`; inspeccionar, medir y cambiar los ajustes con
 * `settings:manage` (gastan cuota).
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced')
export class SeoAdvancedTechnicalController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly inspection: SeoInspectionService,
    private readonly pagespeed: SeoPageSpeedService,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  @RequirePermission('analytics:read')
  @Get('inspections')
  async list(@CurrentUser() user: AuthenticatedUser): Promise<SeoInspectionsDto> {
    return this.inspection.list(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('inspections/history')
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Query('url') url: string | undefined,
  ): Promise<SeoInspectionHistoryDto> {
    return this.inspection.history(user.tenantId, await this.projectId(user), urlParam(url));
  }

  @RequirePermission('settings:manage')
  @Post('inspections')
  @HttpCode(200)
  async inspect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: InspectDto,
  ): Promise<SeoInspectResultDto> {
    return this.inspection.inspect(user.tenantId, await this.projectId(user), body.url, {
      userId: user.sub,
    });
  }

  @RequirePermission('settings:manage')
  @Post('inspections/batch')
  @HttpCode(200)
  async batch(@CurrentUser() user: AuthenticatedUser): Promise<{ queued: number }> {
    const projectId = await this.projectId(user);
    await this.projects.resolveProject(user.tenantId, projectId);
    return { queued: await this.inspection.enqueueBatch(projectId, { force: true }) };
  }

  @RequirePermission('settings:manage')
  @Put('technical/settings')
  async settings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TechnicalSettingsDto,
  ): Promise<SeoTechnicalSettings> {
    return this.inspection.updateSettings(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('analytics:read')
  @Get('pagespeed')
  async pagespeedList(@CurrentUser() user: AuthenticatedUser): Promise<SeoPageSpeedDto> {
    return this.pagespeed.list(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('pagespeed/history')
  async pagespeedHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query('url') url: string | undefined,
    @Query('strategy') strategy: string | undefined,
  ): Promise<SeoPageSpeedHistoryDto> {
    return this.pagespeed.history(
      user.tenantId,
      await this.projectId(user),
      urlParam(url),
      strategyOf(strategy),
    );
  }

  @RequirePermission('settings:manage')
  @Post('pagespeed')
  @HttpCode(200)
  async pagespeedRun(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PageSpeedDto,
  ): Promise<SeoPageSpeedRunDto[]> {
    return this.pagespeed.run(user.tenantId, await this.projectId(user), body, {
      userId: user.sub,
    });
  }
}

/**
 * Lo mismo en el panel admin. Leer: cualquier super admin (también los
 * proyectos de los tenants); inspeccionar, medir y cambiar: el rol
 * superadmin y solo en los proyectos de la plataforma.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id')
export class AdminSeoTechnicalController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly inspection: SeoInspectionService,
    private readonly pagespeed: SeoPageSpeedService,
  ) {}

  @Get('inspections')
  list(@Param('id', ParseUUIDPipe) id: string): Promise<SeoInspectionsDto> {
    return this.inspection.list(undefined, id);
  }

  @Get('inspections/history')
  history(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('url') url: string | undefined,
  ): Promise<SeoInspectionHistoryDto> {
    return this.inspection.history(undefined, id, urlParam(url));
  }

  @Post('inspections')
  @RequireSuperadmin()
  @HttpCode(200)
  inspect(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() body: InspectDto,
  ): Promise<SeoInspectResultDto> {
    return this.inspection.inspect(null, id, body.url, { superAdminId });
  }

  @Post('inspections/batch')
  @RequireSuperadmin()
  @HttpCode(200)
  async batch(@Param('id', ParseUUIDPipe) id: string): Promise<{ queued: number }> {
    await this.projects.resolveProject(null, id);
    return { queued: await this.inspection.enqueueBatch(id, { force: true }) };
  }

  @Put('technical/settings')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.technical_settings_changed')
  settings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TechnicalSettingsDto,
  ): Promise<SeoTechnicalSettings> {
    return this.inspection.updateSettings(null, id, body);
  }

  @Get('pagespeed')
  pagespeedList(@Param('id', ParseUUIDPipe) id: string): Promise<SeoPageSpeedDto> {
    return this.pagespeed.list(undefined, id);
  }

  @Get('pagespeed/history')
  pagespeedHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('url') url: string | undefined,
    @Query('strategy') strategy: string | undefined,
  ): Promise<SeoPageSpeedHistoryDto> {
    return this.pagespeed.history(undefined, id, urlParam(url), strategyOf(strategy));
  }

  @Post('pagespeed')
  @RequireSuperadmin()
  @HttpCode(200)
  pagespeedRun(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() body: PageSpeedDto,
  ): Promise<SeoPageSpeedRunDto[]> {
    return this.pagespeed.run(null, id, body, { superAdminId });
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
  ConnectSeoGa4Schema,
  type ConnectSeoGa4Input,
  SEO_PAGE_PERFORMANCE_SORTS,
  type SeoGa4PageDetailDto,
  type SeoGa4PagesDto,
  type SeoGa4SettingsDto,
  type SeoPagePerformanceSort,
} from '@storageos/shared';

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
import { parsePanelQuery } from '../seo-days';
import { SeoProjectsService } from '../seo-projects.service';

import { SeoGa4Service } from './seo-ga4.service';

/** Unión discriminada: se valida a mano (`createZodDto` no la admite). */
function parseConnect(raw: unknown): ConnectSeoGa4Input {
  const parsed = ConnectSeoGa4Schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'validation_failed',
      message:
        parsed.error.issues[0]?.message ??
        'Pon el número de la propiedad de Google Analytics o usa la de Marketing.',
    });
  }
  return parsed.data;
}

function pagesQuery(q: Record<string, string | undefined>) {
  const base = parsePanelQuery(q);
  const sort = (SEO_PAGE_PERFORMANCE_SORTS as readonly string[]).includes(q.sort ?? '')
    ? (q.sort as SeoPagePerformanceSort)
    : 'clicks';
  return { ...base, domainId: base.domainId ?? null, sort };
}

function pageUrl(url: string | undefined): string {
  const u = (url ?? '').trim();
  if (!u || u.length > 2000) {
    throw new BadRequestException({ code: 'invalid_url', message: 'Falta la página.' });
  }
  return u;
}

const daysOf = (v: string | undefined) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 486) : 90;
};

/**
 * Google Analytics del tráfico orgánico del proyecto del tenant (PR 12). Ver
 * con `analytics:read`; conectar, quitar y sincronizar con `settings:manage`.
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced/ga4')
export class SeoAdvancedGa4Controller {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly ga4: SeoGa4Service,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  @RequirePermission('analytics:read')
  @Get()
  async settings(@CurrentUser() user: AuthenticatedUser): Promise<SeoGa4SettingsDto> {
    return this.ga4.settings(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Put()
  async connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<SeoGa4SettingsDto> {
    return this.ga4.connect(user.tenantId, await this.projectId(user), parseConnect(body));
  }

  @RequirePermission('settings:manage')
  @Delete()
  async disconnect(@CurrentUser() user: AuthenticatedUser): Promise<SeoGa4SettingsDto> {
    return this.ga4.disconnect(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Post('sync')
  @HttpCode(200)
  async sync(@CurrentUser() user: AuthenticatedUser): Promise<SeoGa4SettingsDto> {
    return this.ga4.syncNow(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('pages')
  async pages(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoGa4PagesDto> {
    return this.ga4.pages(user.tenantId, await this.projectId(user), pagesQuery(query));
  }

  @RequirePermission('analytics:read')
  @Get('page')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query('url') url: string | undefined,
    @Query('days') days: string | undefined,
  ): Promise<SeoGa4PageDetailDto> {
    return this.ga4.page(user.tenantId, await this.projectId(user), pageUrl(url), daysOf(days));
  }
}

/**
 * Lo mismo en el panel admin. Leer: cualquier super admin (también los
 * proyectos de los tenants); conectar y sincronizar: el rol superadmin y solo
 * en los proyectos de la plataforma.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id/ga4')
export class AdminSeoGa4Controller {
  constructor(private readonly ga4: SeoGa4Service) {}

  @Get()
  settings(@Param('id', ParseUUIDPipe) id: string): Promise<SeoGa4SettingsDto> {
    return this.ga4.settings(undefined, id);
  }

  @Put()
  @RequireSuperadmin()
  @AdminAudit('admin.seo.ga4_connected')
  connect(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<SeoGa4SettingsDto> {
    return this.ga4.connect(null, id, parseConnect(body));
  }

  @Delete()
  @RequireSuperadmin()
  @AdminAudit('admin.seo.ga4_disconnected')
  disconnect(@Param('id', ParseUUIDPipe) id: string): Promise<SeoGa4SettingsDto> {
    return this.ga4.disconnect(null, id);
  }

  @Post('sync')
  @RequireSuperadmin()
  @HttpCode(200)
  sync(@Param('id', ParseUUIDPipe) id: string): Promise<SeoGa4SettingsDto> {
    return this.ga4.syncNow(null, id);
  }

  @Get('pages')
  pages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoGa4PagesDto> {
    return this.ga4.pages(undefined, id, pagesQuery(query));
  }

  @Get('page')
  page(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('url') url: string | undefined,
    @Query('days') days: string | undefined,
  ): Promise<SeoGa4PageDetailDto> {
    return this.ga4.page(undefined, id, pageUrl(url), daysOf(days));
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  SEO_CRAWL_ISSUE_GROUPS,
  SEO_CRAWL_ISSUE_TYPES,
  SEO_DIAGNOSTIC_STATUSES,
  SEO_SEVERITIES,
  UpdateSeoCrawlSettingsSchema,
  UpdateSeoDiagnosticSchema,
  type SeoCrawlInternalLinksDto,
  type SeoCrawlIssueDto,
  type SeoCrawlIssueGroup,
  type SeoCrawlIssueListDto,
  type SeoCrawlIssueType,
  type SeoCrawlOverviewDto,
  type SeoCrawlPageDetailDto,
  type SeoCrawlPageListDto,
  type SeoCrawlSettings,
  type SeoCrawlStartResultDto,
  type SeoDiagnosticStatus,
  type SeoSeverity,
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

import {
  SeoCrawlViewsService,
  type SeoCrawlIssueQuery,
  type SeoCrawlPageFilter,
  type SeoCrawlPageQuery,
} from './seo-crawl-views.service';
import { SeoCrawlerService } from './seo-crawler.service';

class CrawlSettingsDto extends createZodDto(UpdateSeoCrawlSettingsSchema) {}
class UpdateIssueDto extends createZodDto(UpdateSeoDiagnosticSchema) {}

type Q = Record<string, string | undefined>;
const PAGE_FILTERS: SeoCrawlPageFilter[] = [
  'all',
  'errors',
  'redirects',
  'noindex',
  'blocked',
  'orphans',
  'issues',
];

function oneOf<T extends string>(
  value: string | undefined,
  list: readonly T[],
  name: string,
): T | undefined {
  if (!value) return undefined;
  if (!(list as readonly string[]).includes(value)) {
    throw new BadRequestException({
      code: 'invalid_filter',
      message: `Filtro «${name}» no válido.`,
    });
  }
  return value as T;
}

/** Filtros de la lista de incidencias. */
export function parseCrawlIssueQuery(q: Q): SeoCrawlIssueQuery {
  return {
    severity: oneOf<SeoSeverity>(q.severity, SEO_SEVERITIES, 'gravedad'),
    type: oneOf<SeoCrawlIssueType>(q.type, SEO_CRAWL_ISSUE_TYPES, 'tipo'),
    group: oneOf<SeoCrawlIssueGroup>(q.group, SEO_CRAWL_ISSUE_GROUPS, 'grupo'),
    view: oneOf(q.view, ['open', 'resolved', 'all'] as const, 'vista'),
    status: oneOf<SeoDiagnosticStatus>(q.status, SEO_DIAGNOSTIC_STATUSES, 'estado'),
    onlyNew: q.onlyNew === 'true' || q.onlyNew === '1',
    search: q.search?.trim().slice(0, 200) || undefined,
  };
}

function parsePageQuery(q: Q): SeoCrawlPageQuery {
  return {
    filter: oneOf(q.filter, PAGE_FILTERS, 'páginas'),
    search: q.search?.trim().slice(0, 200) || undefined,
  };
}

function urlParam(url: string | undefined): string {
  const u = (url ?? '').trim();
  if (!u || u.length > 2000) {
    throw new BadRequestException({ code: 'invalid_url', message: 'Falta la URL.' });
  }
  return u;
}

/**
 * Rastreador de la web del proyecto del tenant (PR 10). Ver con
 * `analytics:read`; rastrear, cancelar, cambiar los ajustes y el estado de
 * las incidencias con `settings:manage`.
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced/crawl')
export class SeoAdvancedCrawlController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly crawler: SeoCrawlerService,
    private readonly views: SeoCrawlViewsService,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  @RequirePermission('analytics:read')
  @Get()
  async overview(@CurrentUser() user: AuthenticatedUser): Promise<SeoCrawlOverviewDto> {
    return this.views.overview(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('settings:manage')
  @Post()
  @HttpCode(200)
  async start(@CurrentUser() user: AuthenticatedUser): Promise<SeoCrawlStartResultDto> {
    return this.crawler.start(user.tenantId, await this.projectId(user), { userId: user.sub });
  }

  @RequirePermission('settings:manage')
  @Post(':crawlId/cancel')
  @HttpCode(204)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('crawlId', ParseUUIDPipe) crawlId: string,
  ): Promise<void> {
    await this.crawler.cancel(user.tenantId, await this.projectId(user), crawlId);
  }

  @RequirePermission('settings:manage')
  @Put('settings')
  async settings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CrawlSettingsDto,
  ): Promise<SeoCrawlSettings> {
    return this.crawler.updateSettings(user.tenantId, await this.projectId(user), body);
  }

  @RequirePermission('analytics:read')
  @Get('issues')
  async issues(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: Q,
  ): Promise<SeoCrawlIssueListDto> {
    return this.views.issues(user.tenantId, await this.projectId(user), parseCrawlIssueQuery(q));
  }

  @RequirePermission('analytics:read')
  @Get('issues/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="rastreo-incidencias.csv"')
  async issuesCsv(@CurrentUser() user: AuthenticatedUser, @Query() q: Q): Promise<string> {
    return this.views.issuesCsv(user.tenantId, await this.projectId(user), parseCrawlIssueQuery(q));
  }

  @RequirePermission('settings:manage')
  @Patch('issues/:issueId')
  async updateIssue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() body: UpdateIssueDto,
  ): Promise<SeoCrawlIssueDto> {
    return this.views.updateIssue(user.tenantId, await this.projectId(user), issueId, body);
  }

  @RequirePermission('analytics:read')
  @Get('pages')
  async pages(@CurrentUser() user: AuthenticatedUser, @Query() q: Q): Promise<SeoCrawlPageListDto> {
    return this.views.pages(user.tenantId, await this.projectId(user), parsePageQuery(q));
  }

  @RequirePermission('analytics:read')
  @Get('page')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query('url') url: string | undefined,
  ): Promise<SeoCrawlPageDetailDto> {
    return this.views.pageDetail(user.tenantId, await this.projectId(user), urlParam(url));
  }

  @RequirePermission('analytics:read')
  @Get('internal-links')
  async internalLinks(@CurrentUser() user: AuthenticatedUser): Promise<SeoCrawlInternalLinksDto> {
    return this.views.internalLinks(user.tenantId, await this.projectId(user));
  }
}

/**
 * Lo mismo en el panel admin. Leer: cualquier super admin (también los
 * proyectos de los tenants); rastrear, cancelar y cambiar: el rol superadmin
 * y solo en los proyectos de la plataforma.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id/crawl')
export class AdminSeoCrawlController {
  constructor(
    private readonly crawler: SeoCrawlerService,
    private readonly views: SeoCrawlViewsService,
  ) {}

  @Get()
  overview(@Param('id', ParseUUIDPipe) id: string): Promise<SeoCrawlOverviewDto> {
    return this.views.overview(undefined, id);
  }

  @Post()
  @RequireSuperadmin()
  @HttpCode(200)
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
  ): Promise<SeoCrawlStartResultDto> {
    return this.crawler.start(null, id, { superAdminId });
  }

  @Post(':crawlId/cancel')
  @RequireSuperadmin()
  @HttpCode(204)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('crawlId', ParseUUIDPipe) crawlId: string,
  ): Promise<void> {
    await this.crawler.cancel(null, id, crawlId);
  }

  @Put('settings')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.crawl_settings_changed')
  settings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CrawlSettingsDto,
  ): Promise<SeoCrawlSettings> {
    return this.crawler.updateSettings(null, id, body);
  }

  @Get('issues')
  issues(@Param('id', ParseUUIDPipe) id: string, @Query() q: Q): Promise<SeoCrawlIssueListDto> {
    return this.views.issues(undefined, id, parseCrawlIssueQuery(q));
  }

  @Get('issues/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="rastreo-incidencias.csv"')
  issuesCsv(@Param('id', ParseUUIDPipe) id: string, @Query() q: Q): Promise<string> {
    return this.views.issuesCsv(undefined, id, parseCrawlIssueQuery(q));
  }

  @Patch('issues/:issueId')
  @RequireSuperadmin()
  updateIssue(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() body: UpdateIssueDto,
  ): Promise<SeoCrawlIssueDto> {
    return this.views.updateIssue(null, id, issueId, body);
  }

  @Get('pages')
  pages(@Param('id', ParseUUIDPipe) id: string, @Query() q: Q): Promise<SeoCrawlPageListDto> {
    return this.views.pages(undefined, id, parsePageQuery(q));
  }

  @Get('page')
  page(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('url') url: string | undefined,
  ): Promise<SeoCrawlPageDetailDto> {
    return this.views.pageDetail(undefined, id, urlParam(url));
  }

  @Get('internal-links')
  internalLinks(@Param('id', ParseUUIDPipe) id: string): Promise<SeoCrawlInternalLinksDto> {
    return this.views.internalLinks(undefined, id);
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_CRAWLER_USER_AGENT,
  SEO_CRAWL_ISSUES,
  SEO_CRAWL_ISSUE_LIST_MAX,
  SEO_CRAWL_PAGE_LIST_MAX,
  SEO_DIAGNOSTIC_STATUS_LABELS,
  SEO_SEVERITIES,
  SEO_SEVERITY_LABELS,
  normalizeSeoUrl,
  seoAbsoluteUrl,
  seoThresholdsOf,
  type SeoCrawlInternalLinksDto,
  type SeoCrawlIssueDto,
  type SeoCrawlIssueGroup,
  type SeoCrawlIssueListDto,
  type SeoCrawlIssueType,
  type SeoCrawlOverviewDto,
  type SeoCrawlPageDetailDto,
  type SeoCrawlPageListDto,
  type SeoDiagnosticStatus,
  type SeoSeverity,
  type UpdateSeoDiagnosticInput,
} from '@storageos/shared';

import { CSV_BOM, csvCell, csvLineCell } from '../../../common/csv';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoProjectsService, type SeoOwner } from '../seo-projects.service';
import { SeoTechnicalReadService } from '../technical/seo-technical-read.service';

import { crawlDto, crawlIssueDto, crawlPageDto, type CrawlRow } from './seo-crawl-dto';
import { SeoCrawlerService } from './seo-crawler.service';

export interface SeoCrawlIssueQuery {
  severity?: SeoSeverity | undefined;
  type?: SeoCrawlIssueType | undefined;
  group?: SeoCrawlIssueGroup | undefined;
  /** open (pendientes que siguen saliendo, por defecto) · resolved · all */
  view?: 'open' | 'resolved' | 'all' | undefined;
  status?: SeoDiagnosticStatus | undefined;
  onlyNew?: boolean | undefined;
  search?: string | undefined;
}

export type SeoCrawlPageFilter =
  | 'all'
  | 'errors'
  | 'redirects'
  | 'noindex'
  | 'blocked'
  | 'orphans'
  | 'issues';

export interface SeoCrawlPageQuery {
  filter?: SeoCrawlPageFilter | undefined;
  search?: string | undefined;
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Lo que enseña la sección «Rastreo» (PR 10): el último rastreo y el vivo,
 * las incidencias con sus filtros y su CSV, las páginas (huérfanas incluidas),
 * la ficha de cada URL con los enlaces que entran y salen y el enlazado
 * interno de las URL objetivo.
 */
@Injectable()
export class SeoCrawlViewsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly crawler: SeoCrawlerService,
    private readonly read: SeoTechnicalReadService,
  ) {}

  private notFound() {
    return new NotFoundException({ code: 'not_found', message: 'No existe.' });
  }

  private async creators(rows: CrawlRow[]): Promise<Map<string, string>> {
    const userIds = [
      ...new Set(rows.map((r) => r.createdByUserId).filter((x): x is string => !!x)),
    ];
    const adminIds = [
      ...new Set(rows.map((r) => r.createdBySuperAdminId).filter((x): x is string => !!x)),
    ];
    const [users, admins] = await Promise.all([
      userIds.length
        ? this.admin.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, fullName: true },
          })
        : Promise.resolve([]),
      adminIds.length
        ? this.admin.superAdmin.findMany({
            where: { id: { in: adminIds } },
            select: { id: true, fullName: true },
          })
        : Promise.resolve([]),
    ]);
    return new Map([...users, ...admins].map((u) => [u.id, u.fullName]));
  }

  async overview(owner: SeoOwner | undefined, projectId: string): Promise<SeoCrawlOverviewDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const history = await this.admin.seoCrawl.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const names = await this.creators(history);
    const dto = (r: CrawlRow) =>
      crawlDto(r, names.get(r.createdByUserId ?? r.createdBySuperAdminId ?? '') ?? null);
    const live = history.find((r) => r.status === 'queued' || r.status === 'running') ?? null;
    const last =
      history.find((r) => r.status === 'done') ??
      (await this.admin.seoCrawl.findFirst({
        where: { projectId, status: 'done' },
        orderBy: { createdAt: 'desc' },
      }));
    const open = await this.admin.seoCrawlIssue.groupBy({
      by: ['severity', 'type'],
      where: { projectId, active: true, status: { in: ['new', 'reviewed'] } },
      _count: { _all: true },
    });
    const bySeverity = Object.fromEntries(SEO_SEVERITIES.map((s) => [s, 0])) as Record<
      SeoSeverity,
      number
    >;
    const byType: Partial<Record<SeoCrawlIssueType, number>> = {};
    for (const g of open) {
      bySeverity[g.severity as SeoSeverity] += g._count._all;
      const t = g.type as SeoCrawlIssueType;
      byType[t] = (byType[t] ?? 0) + g._count._all;
    }
    return {
      settings: this.crawler.settingsOf(project),
      live: live ? dto(live) : null,
      last: last ? dto(last) : null,
      history: history.map(dto),
      open: { bySeverity, byType },
      userAgent: SEO_CRAWLER_USER_AGENT,
    };
  }

  // ---------------------------------------------------------- incidencias

  private issueWhere(projectId: string, q: SeoCrawlIssueQuery): Prisma.SeoCrawlIssueWhereInput {
    const view = q.view ?? 'open';
    const types = q.group
      ? (Object.keys(SEO_CRAWL_ISSUES) as SeoCrawlIssueType[]).filter(
          (t) => SEO_CRAWL_ISSUES[t].group === q.group,
        )
      : null;
    return {
      projectId,
      ...(view === 'open'
        ? { active: true, status: q.status ?? { in: ['new', 'reviewed'] } }
        : view === 'resolved'
          ? { active: false, ...(q.status ? { status: q.status } : {}) }
          : q.status
            ? { status: q.status }
            : {}),
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.type ? { type: q.type } : types ? { type: { in: types } } : {}),
      ...(q.search ? { url: { contains: q.search, mode: 'insensitive' as const } } : {}),
    };
  }

  async issues(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoCrawlIssueQuery,
  ): Promise<SeoCrawlIssueListDto> {
    await this.projects.resolveProject(owner, projectId);
    const last = await this.read.latestCrawl(projectId);
    const where = this.issueWhere(projectId, q);
    if (q.onlyNew && last) where.appearedCrawlId = last.id;
    const [total, rows] = await Promise.all([
      this.admin.seoCrawlIssue.count({ where }),
      this.admin.seoCrawlIssue.findMany({
        where,
        orderBy: [{ lastSeenAt: 'desc' }, { url: 'asc' }],
        take: SEO_CRAWL_ISSUE_LIST_MAX * 4,
      }),
    ]);
    const items = rows
      .map((r) => crawlIssueDto(r, last?.id ?? null))
      .sort(
        (a, b) =>
          (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) ||
          a.type.localeCompare(b.type) ||
          a.url.localeCompare(b.url),
      )
      .slice(0, SEO_CRAWL_ISSUE_LIST_MAX);
    return { crawlId: last?.id ?? null, total, items };
  }

  async updateIssue(
    owner: SeoOwner,
    projectId: string,
    id: string,
    input: UpdateSeoDiagnosticInput,
  ): Promise<SeoCrawlIssueDto> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.admin.seoCrawlIssue.findFirst({ where: { id, projectId } });
    if (!row) throw this.notFound();
    const data: Prisma.SeoCrawlIssueUpdateInput = {};
    if (input.status !== undefined && input.status !== row.status) {
      data.status = input.status;
      if (input.status === 'fixed' || input.status === 'ok')
        data.resolvedAt = row.resolvedAt ?? new Date();
      else if (row.active) {
        data.resolvedAt = null;
        data.returnedAt = null;
      }
    }
    if (input.notes !== undefined) data.notes = input.notes || null;
    const updated = await this.admin.seoCrawlIssue.update({ where: { id }, data });
    const last = await this.read.latestCrawl(projectId);
    return crawlIssueDto(updated, last?.id ?? null);
  }

  async issuesCsv(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoCrawlIssueQuery,
  ): Promise<string> {
    const { items } = await this.issues(owner, projectId, q);
    const header = [
      'Gravedad',
      'Incidencia',
      'URL',
      'Detalle',
      'Qué hacer',
      'Estado',
      'Sigue',
      'Nueva',
      'Vista por primera vez',
      'Vista por última vez',
      'Notas',
    ];
    const lines = [header.map(csvCell).join(';')];
    for (const i of items) {
      lines.push(
        [
          csvCell(SEO_SEVERITY_LABELS[i.severity]),
          csvCell(i.label),
          csvCell(i.url),
          csvLineCell(i.detail),
          csvLineCell(i.how),
          csvCell(SEO_DIAGNOSTIC_STATUS_LABELS[i.status]),
          csvCell(i.active ? 'Sí' : 'No'),
          csvCell(i.isNew ? 'Sí' : 'No'),
          csvCell(i.firstSeenAt.slice(0, 10)),
          csvCell(i.lastSeenAt.slice(0, 10)),
          csvLineCell(i.notes),
        ].join(';'),
      );
    }
    return CSV_BOM + lines.join('\r\n');
  }

  // ---------------------------------------------------------------- páginas

  async pages(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoCrawlPageQuery,
  ): Promise<SeoCrawlPageListDto> {
    await this.projects.resolveProject(owner, projectId);
    const last = await this.read.latestCrawl(projectId);
    if (!last) return { crawlId: null, total: 0, items: [] };
    const filter = q.filter ?? 'all';
    const where: Prisma.SeoCrawlPageWhereInput = {
      crawlId: last.id,
      ...(q.search ? { url: { contains: q.search, mode: 'insensitive' as const } } : {}),
      ...(filter === 'errors'
        ? { inScope: true, OR: [{ error: { not: null } }, { status: { gte: 400 } }] }
        : filter === 'redirects'
          ? { status: { gte: 300, lt: 400 } }
          : filter === 'noindex'
            ? { noindex: true }
            : filter === 'blocked'
              ? { OR: [{ robotsBlocked: true }, { googleBlocked: true }] }
              : filter === 'issues'
                ? { issues: { gt: 0 } }
                : filter === 'orphans'
                  ? {
                      inScope: true,
                      inlinks: 0,
                      noindex: false,
                      status: { gte: 200, lt: 300 },
                      OR: [{ inSitemap: true }, { impressions: { gt: 0 } }],
                      NOT: { source: 'home' },
                    }
                  : {}),
    };
    const [total, rows] = await Promise.all([
      this.admin.seoCrawlPage.count({ where }),
      this.admin.seoCrawlPage.findMany({
        where,
        orderBy:
          filter === 'orphans'
            ? [{ impressions: 'desc' }, { url: 'asc' }]
            : [{ issues: 'desc' }, { depth: 'asc' }, { url: 'asc' }],
        take: SEO_CRAWL_PAGE_LIST_MAX,
      }),
    ]);
    return { crawlId: last.id, total, items: rows.map(crawlPageDto) };
  }

  /** Ficha de una URL en el último rastreo (en el que esté). */
  async pageDetail(
    owner: SeoOwner | undefined,
    projectId: string,
    rawUrl: string,
  ): Promise<SeoCrawlPageDetailDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0];
    const key = normalizeSeoUrl(seoAbsoluteUrl(rawUrl, primary?.domain ?? ''));
    const row = await this.admin.seoCrawlPage.findFirst({
      where: { projectId, urlKey: key, crawl: { status: 'done' } },
      orderBy: { createdAt: 'desc' },
      include: { crawl: { select: { finishedAt: true, createdAt: true } } },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'seo_crawl_page_missing',
        message: 'El rastreo no tiene esa URL.',
      });
    }
    const [linksIn, issues, inspection] = await Promise.all([
      this.admin.$queryRaw<{ url: string }[]>(Prisma.sql`
        SELECT url FROM seo_crawl_pages
        WHERE crawl_id = ${row.crawlId}::uuid AND link_keys @> ARRAY[${key}]::text[]
          AND url_key <> ${key}
        ORDER BY depth NULLS LAST, url LIMIT 200`),
      this.admin.seoCrawlIssue.findMany({
        where: { projectId, urlKey: key },
        orderBy: [{ active: 'desc' }, { lastSeenAt: 'desc' }],
        take: 100,
      }),
      this.read.indexStatuses(projectId, [key]),
    ]);
    const lastId = (await this.read.latestCrawl(projectId))?.id ?? null;
    return {
      ...crawlPageDto(row),
      crawledAt: (row.crawl.finishedAt ?? row.crawl.createdAt).toISOString(),
      contentType: row.contentType,
      redirectChain: (row.redirectChain ?? []) as string[],
      description: row.description,
      h1: row.h1,
      canonical: row.canonical,
      nofollow: row.nofollow,
      googleBlocked: row.googleBlocked,
      robotsRule: row.robotsRule,
      hreflang: (row.hreflang ?? []) as { lang: string; href: string }[],
      jsonLdTypes: row.jsonLdTypes,
      imagesTotal: row.imagesTotal,
      imagesWithoutAlt: row.imagesWithoutAlt,
      linksIn: linksIn.map((l) => l.url),
      linksOut: row.links,
      issuesList: issues.map((i) => crawlIssueDto(i, lastId)),
      inspection: inspection.get(key) ?? null,
    };
  }

  async internalLinks(
    owner: SeoOwner | undefined,
    projectId: string,
  ): Promise<SeoCrawlInternalLinksDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const min = seoThresholdsOf(project.opportunitySettings).internalLinksMin;
    return this.read.internalLinks(projectId, min);
  }
}

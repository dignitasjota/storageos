import {
  SEO_CRAWL_ISSUES,
  type SeoCrawlDto,
  type SeoCrawlIssueDto,
  type SeoCrawlIssueType,
  type SeoCrawlPageDto,
  type SeoCrawlRobotsDto,
  type SeoCrawlSource,
  type SeoCrawlStatus,
  type SeoCrawlStopReason,
  type SeoCrawlTrigger,
  type SeoDiagnosticStatus,
  type SeoSeverity,
} from '@storageos/shared';

import type { Prisma } from '@storageos/database';

export type CrawlRow = Prisma.SeoCrawlGetPayload<object>;
export type CrawlPageRow = Prisma.SeoCrawlPageGetPayload<object>;
export type CrawlIssueRow = Prisma.SeoCrawlIssueGetPayload<object>;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Un rastreo para la pantalla (`createdBy`: el nombre lo pone quien lo lee). */
export function crawlDto(r: CrawlRow, createdBy: string | null = null): SeoCrawlDto {
  const sitemaps = r.sitemaps as {
    urls?: string[];
    pages?: number;
    errors?: { url: string; error: string }[];
  } | null;
  return {
    id: r.id,
    status: r.status as SeoCrawlStatus,
    trigger: r.trigger as SeoCrawlTrigger,
    startUrl: r.startUrl,
    pagesCrawled: r.pagesCrawled,
    pagesFound: r.pagesFound,
    errors: r.errors,
    durationMs: r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
    stopReason: (r.stopReason as SeoCrawlStopReason) ?? null,
    error: r.error,
    summary: (r.summary as SeoCrawlDto['summary']) ?? null,
    robots: (r.robots as unknown as SeoCrawlRobotsDto | null) ?? null,
    sitemaps: sitemaps
      ? {
          urls: sitemaps.urls ?? [],
          pages: sitemaps.pages ?? 0,
          errors: sitemaps.errors ?? [],
        }
      : null,
    createdBy,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
  };
}

export function crawlIssueDto(r: CrawlIssueRow, lastCrawlId: string | null): SeoCrawlIssueDto {
  const type = r.type as SeoCrawlIssueType;
  const info = SEO_CRAWL_ISSUES[type];
  return {
    id: r.id,
    type,
    group: info?.group ?? 'other',
    label: info?.label ?? type,
    severity: r.severity as SeoSeverity,
    url: r.url,
    detail: r.detail,
    what: info?.what ?? '',
    how: info?.how ?? '',
    data: (r.data ?? {}) as Record<string, unknown>,
    status: r.status as SeoDiagnosticStatus,
    notes: r.notes,
    active: r.active,
    isNew: r.active && !!lastCrawlId && r.appearedCrawlId === lastCrawlId,
    returnedAt: iso(r.returnedAt),
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    resolvedAt: iso(r.resolvedAt),
  };
}

export function crawlPageDto(r: CrawlPageRow): SeoCrawlPageDto {
  return {
    id: r.id,
    url: r.url,
    status: r.status,
    finalUrl: r.finalUrl,
    responseMs: r.responseMs,
    depth: r.depth,
    inlinks: r.inlinks,
    outlinks: r.links.length,
    title: r.title,
    noindex: r.noindex,
    robotsBlocked: r.robotsBlocked,
    inSitemap: r.inSitemap,
    impressions: r.impressions,
    source: r.source as SeoCrawlSource,
    issues: r.issues,
    error: r.error,
  };
}

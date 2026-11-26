import { Injectable } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  normalizeSeoUrl,
  seoAbsoluteUrl,
  seoIndexStatusLabel,
  seoInspectionUrlKey,
  seoQueryTokens,
  seoRelatedQuery,
  seoInspectionRecent,
  seoNotIndexedReason,
  type SeoCrawlInternalLinkDto,
  type SeoCrawlInternalLinksDto,
  type SeoCrawlUrlFacts,
  type SeoFieldCategory,
  type SeoInspectionReason,
  type SeoPageSpeedOpportunityDto,
  type SeoPageSpeedFieldDto,
  type SeoPageSpeedRunDto,
  type SeoPageSpeedStrategy,
  type SeoTechnicalTrigger,
  type SeoUrlIndexStatusDto,
  type SeoUrlInspectionDto,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';

export type InspectionRow = Prisma.SeoUrlInspectionGetPayload<object>;
export type PageSpeedRow = Prisma.SeoPageSpeedRunGetPayload<object>;
type LatestCrawl = Prisma.SeoCrawlGetPayload<object>;

/** Días de Search Console para las páginas sugeridas del enlazado interno. */
const SUGGESTION_DAYS = 28;
/** URL objetivo como mucho en el enlazado interno. */
const MAX_TARGETS = 500;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Lo que dice Google de la URL de una fila de inspección terminada. */
export function indexStatusOf(r: InspectionRow, now = new Date()): SeoUrlIndexStatusDto {
  const inspectedAt = (r.inspectedAt ?? r.updatedAt).toISOString();
  const reason =
    r.indexed === false
      ? seoNotIndexedReason({
          robotsTxtState: r.robotsTxtState,
          indexingState: r.indexingState,
          pageFetchState: r.pageFetchState,
          coverageState: r.coverageState,
          canonicalMismatch: r.canonicalMismatch,
        })
      : null;
  return {
    url: r.url,
    inspectedAt,
    indexed: r.indexed,
    verdict: r.verdict,
    reason,
    label: seoIndexStatusLabel({ indexed: r.indexed, inspectedAt, reason }),
    googleCanonical: r.googleCanonical,
    userCanonical: r.userCanonical,
    canonicalMismatch: r.canonicalMismatch,
    lastCrawlAt: iso(r.lastCrawlAt),
    stale: !seoInspectionRecent(inspectedAt, now),
  };
}

export function inspectionDto(r: InspectionRow): SeoUrlInspectionDto {
  const res = (r.result ?? {}) as {
    sitemaps?: string[];
    referringUrls?: string[];
    mobileUsability?: SeoUrlInspectionDto['mobileUsability'];
    richResults?: SeoUrlInspectionDto['richResults'];
    link?: string | null;
  };
  return {
    id: r.id,
    url: r.url,
    domain: r.domain,
    status: r.status as SeoUrlInspectionDto['status'],
    trigger: r.trigger as SeoTechnicalTrigger,
    reason: r.reason as SeoInspectionReason,
    scheduledFor: iso(r.scheduledFor),
    inspectedAt: iso(r.inspectedAt),
    verdict: r.verdict,
    indexed: r.indexed,
    coverageState: r.coverageState,
    robotsTxtState: r.robotsTxtState,
    indexingState: r.indexingState,
    pageFetchState: r.pageFetchState,
    crawledAs: r.crawledAs,
    lastCrawlAt: iso(r.lastCrawlAt),
    googleCanonical: r.googleCanonical,
    userCanonical: r.userCanonical,
    canonicalMismatch: r.canonicalMismatch,
    notIndexedReason:
      r.status === 'done' && r.indexed === false
        ? seoNotIndexedReason({
            robotsTxtState: r.robotsTxtState,
            indexingState: r.indexingState,
            pageFetchState: r.pageFetchState,
            coverageState: r.coverageState,
            canonicalMismatch: r.canonicalMismatch,
          })
        : null,
    sitemaps: res.sitemaps ?? [],
    referringUrls: res.referringUrls ?? [],
    mobileUsability: res.mobileUsability ?? null,
    richResults: res.richResults ?? null,
    link: res.link ?? null,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  };
}

export function pageSpeedDto(r: PageSpeedRow): SeoPageSpeedRunDto {
  const field: SeoPageSpeedFieldDto | null = r.fieldScope
    ? {
        scope: r.fieldScope as 'url' | 'origin',
        overall: r.fieldOverall as SeoFieldCategory | null,
        lcpMs: r.fieldLcpMs,
        lcpCategory: null,
        inpMs: r.fieldInpMs,
        inpCategory: null,
        cls: r.fieldCls,
        clsCategory: null,
        ...(((r.field ?? {}) as Record<string, SeoPageSpeedFieldDto | null>)[r.fieldScope] ?? {}),
      }
    : null;
  return {
    id: r.id,
    url: r.url,
    strategy: r.strategy as SeoPageSpeedStrategy,
    status: r.status as SeoPageSpeedRunDto['status'],
    trigger: r.trigger as SeoTechnicalTrigger,
    scores: {
      performance: r.performanceScore,
      seo: r.seoScore,
      accessibility: r.accessibilityScore,
      bestPractices: r.bestPracticesScore,
    },
    lab: {
      lcpMs: r.lcpMs,
      cls: r.cls,
      tbtMs: r.tbtMs,
      fcpMs: r.fcpMs,
      siMs: r.siMs,
      ttiMs: r.ttiMs,
    },
    field,
    opportunities: (r.opportunities ?? []) as unknown as SeoPageSpeedOpportunityDto[],
    error: r.error,
    analyzedAt: iso(r.analyzedAt),
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Lecturas de la inspección de URL y de PageSpeed que usan otras partes del
 * módulo (indexación, palabras seguidas, oportunidades, alertas e informes).
 * Solo depende de la base de datos para no crear dependencias circulares.
 */
@Injectable()
export class SeoTechnicalReadService {
  constructor(private readonly admin: PrismaAdminService) {}

  /** Última inspección terminada de cada URL (clave normalizada → fila). */
  async latestInspections(
    projectId: string,
    urlKeys?: readonly string[],
  ): Promise<Map<string, InspectionRow>> {
    if (urlKeys && urlKeys.length === 0) return new Map();
    const ids = await this.admin.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT DISTINCT ON (url_key) id::text AS id FROM seo_url_inspections
      WHERE project_id = ${projectId}::uuid AND status = 'done'
        ${urlKeys ? Prisma.sql`AND url_key = ANY(${[...urlKeys]}::text[])` : Prisma.empty}
      ORDER BY url_key, inspected_at DESC NULLS LAST, created_at DESC`);
    if (ids.length === 0) return new Map();
    const rows = await this.admin.seoUrlInspection.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
    });
    return new Map(rows.map((r) => [r.urlKey, r]));
  }

  /** Lo que dice Google de cada URL pedida (las que tengan inspección). */
  async indexStatuses(
    projectId: string,
    urlKeys: readonly string[],
  ): Promise<Map<string, SeoUrlIndexStatusDto>> {
    const rows = await this.latestInspections(projectId, [...new Set(urlKeys)]);
    const now = new Date();
    return new Map([...rows].map(([k, r]) => [k, indexStatusOf(r, now)]));
  }

  /** Las dos últimas mediciones terminadas de cada URL y estrategia (la más reciente primero). */
  async latestPageSpeed(projectId: string): Promise<Map<string, PageSpeedRow[]>> {
    const ids = await this.admin.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id::text AS id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY url_key, strategy ORDER BY analyzed_at DESC NULLS LAST, created_at DESC
        ) AS n
        FROM seo_pagespeed_runs WHERE project_id = ${projectId}::uuid AND status = 'done'
      ) t WHERE n <= 2`);
    if (ids.length === 0) return new Map();
    const rows = await this.admin.seoPageSpeedRun.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      orderBy: [{ analyzedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const out = new Map<string, PageSpeedRow[]>();
    for (const r of rows) {
      const k = `${r.urlKey}|${r.strategy}`;
      out.set(k, [...(out.get(k) ?? []), r]);
    }
    return out;
  }

  // ------------------------------------------------------- rastreador (PR 10)

  /** El último rastreo terminado del proyecto. */
  latestCrawl(projectId: string): Promise<LatestCrawl | null> {
    return this.admin.seoCrawl.findFirst({
      where: { projectId, status: 'done' },
      orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** Lo que vio el rastreador de cada URL pedida (su rastreo terminado más reciente). */
  async crawlFacts(
    projectId: string,
    urlKeys: readonly string[],
  ): Promise<Map<string, SeoCrawlUrlFacts>> {
    const keys = [...new Set(urlKeys)];
    if (keys.length === 0) return new Map();
    const rows = await this.admin.$queryRaw<
      {
        url: string;
        url_key: string;
        created_at: Date;
        status: number | null;
        final_status: number | null;
        final_url: string | null;
        error: string | null;
        noindex: boolean;
        robots_blocked: boolean;
        google_blocked: boolean;
        canonical: string | null;
        in_sitemap: boolean;
        inlinks: number;
        finished_at: Date | null;
      }[]
    >(Prisma.sql`
      SELECT DISTINCT ON (p.url_key) p.url, p.url_key, p.created_at, p.status, p.final_status,
        p.final_url, p.error, p.noindex, p.robots_blocked, p.google_blocked, p.canonical,
        p.in_sitemap, p.inlinks, c.finished_at
      FROM seo_crawl_pages p JOIN seo_crawls c ON c.id = p.crawl_id
      WHERE p.project_id = ${projectId}::uuid AND c.status = 'done'
        AND p.url_key = ANY(${keys}::text[])
      ORDER BY p.url_key, c.finished_at DESC NULLS LAST, p.created_at DESC`);
    return new Map(
      rows.map((r) => [
        r.url_key,
        {
          url: r.url,
          crawledAt: (r.finished_at ?? r.created_at).toISOString(),
          status: r.status,
          finalStatus: r.final_status,
          finalUrl: r.final_url,
          error: r.error,
          noindex: r.noindex,
          robotsBlocked: r.robots_blocked,
          googleBlocked: r.google_blocked,
          canonical: r.canonical,
          inSitemap: r.in_sitemap,
          inlinks: r.inlinks,
        },
      ]),
    );
  }

  /**
   * Enlazado interno de las URL objetivo de las palabras seguidas en el
   * último rastreo: cuántos enlaces internos le llegan y desde dónde, y desde
   * qué páginas conviene enlazarla (las que salen en Google para búsquedas
   * relacionadas con sus palabras y aún no la enlazan).
   */
  async internalLinks(projectId: string, min: number): Promise<SeoCrawlInternalLinksDto> {
    const crawl = await this.latestCrawl(projectId);
    if (!crawl) return { crawlId: null, crawledAt: null, min, items: [] };
    const project = await this.admin.seoProject.findUnique({
      where: { id: projectId },
      include: { domains: true },
    });
    const primary =
      project?.domains.find((d) => d.role === 'primary') ?? project?.domains[0] ?? null;
    const base = primary?.domain ?? '';
    const keywords = await this.admin.seoProjectKeyword.findMany({
      where: { projectId, isActive: true, targetUrl: { not: null } },
      select: { targetUrl: true, priority: true, keyword: { select: { keyword: true } } },
      orderBy: [{ priority: 'asc' }],
      take: 5000,
    });
    const byTarget = new Map<
      string,
      { url: string; keywords: { keyword: string; priority: number }[] }
    >();
    for (const k of keywords) {
      const key = seoInspectionUrlKey(k.targetUrl!, base);
      const t = byTarget.get(key) ?? {
        url: seoAbsoluteUrl(k.targetUrl!, base),
        keywords: [],
      };
      t.keywords.push({ keyword: k.keyword.keyword, priority: k.priority });
      byTarget.set(key, t);
    }
    const keys = [...byTarget.keys()].slice(0, MAX_TARGETS);
    if (keys.length === 0) {
      return {
        crawlId: crawl.id,
        crawledAt: (crawl.finishedAt ?? crawl.createdAt).toISOString(),
        min,
        items: [],
      };
    }
    const [pages, sources] = await Promise.all([
      this.admin.seoCrawlPage.findMany({
        where: { crawlId: crawl.id, urlKey: { in: keys } },
        select: { urlKey: true, url: true, status: true, inlinks: true, depth: true },
      }),
      this.admin.$queryRaw<{ url: string; url_key: string; link_keys: string[] }[]>(Prisma.sql`
        SELECT url, url_key, link_keys FROM seo_crawl_pages
        WHERE crawl_id = ${crawl.id}::uuid AND link_keys && ${keys}::text[]`),
    ]);
    const pageOf = new Map(pages.map((p) => [p.urlKey, p]));
    const linkedFrom = new Map<string, { url: string; key: string }[]>();
    const wanted = new Set(keys);
    for (const s of sources) {
      for (const lk of s.link_keys) {
        if (!wanted.has(lk) || lk === s.url_key) continue;
        linkedFrom.set(lk, [...(linkedFrom.get(lk) ?? []), { url: s.url, key: s.url_key }]);
      }
    }

    // Páginas con impresiones para búsquedas relacionadas (cruce búsqueda + página).
    const tokens = [
      ...new Set(
        keys.flatMap((k) => byTarget.get(k)!.keywords.flatMap((w) => seoQueryTokens(w.keyword))),
      ),
    ].slice(0, 200);
    const until = primary?.dataUntil;
    const related =
      primary && until && tokens.length > 0
        ? await this.admin.$queryRaw<{ query: string; page: string; i: number }[]>(Prisma.sql`
          SELECT query, page, SUM(impressions)::float8 AS i FROM seo_gsc_metrics
          WHERE domain_id = ${primary.id}::uuid AND grain = 'query_page'
            AND date BETWEEN ${new Date(until.getTime() - (SUGGESTION_DAYS - 1) * 86_400_000)}::date
              AND ${until}::date
            AND query ILIKE ANY(${tokens.map((t) => `%${t}%`)}::text[])
          GROUP BY query, page HAVING SUM(impressions) > 0
          ORDER BY i DESC LIMIT 20000`)
        : [];

    const items: SeoCrawlInternalLinkDto[] = keys.map((key) => {
      const t = byTarget.get(key)!;
      const page = pageOf.get(key);
      const from = linkedFrom.get(key) ?? [];
      const fromKeys = new Set(from.map((f) => f.key));
      const scores = new Map<
        string,
        { url: string; impressions: number; query: string; best: number }
      >();
      for (const r of related) {
        const pk = normalizeSeoUrl(r.page);
        if (pk === key || fromKeys.has(pk)) continue;
        if (!t.keywords.some((w) => seoRelatedQuery(w.keyword, r.query))) continue;
        const i = Number(r.i);
        const cur = scores.get(pk) ?? { url: r.page, impressions: 0, query: r.query, best: 0 };
        cur.impressions += i;
        if (i > cur.best) {
          cur.best = i;
          cur.query = r.query;
        }
        scores.set(pk, cur);
      }
      const inlinks = page?.inlinks ?? from.length;
      return {
        url: page?.url ?? t.url,
        urlKey: key,
        keywords: t.keywords,
        crawled: !!page,
        status: page?.status ?? null,
        inlinks,
        sources: from.slice(0, 20).map((f) => f.url),
        depth: page?.depth ?? null,
        few: inlinks < min,
        suggestions: [...scores.values()]
          .sort((a, b) => b.impressions - a.impressions)
          .slice(0, 5)
          .map((x) => ({ url: x.url, impressions: Math.round(x.impressions), query: x.query })),
      };
    });
    items.sort((a, b) => a.inlinks - b.inlinks || a.url.localeCompare(b.url));
    return {
      crawlId: crawl.id,
      crawledAt: (crawl.finishedAt ?? crawl.createdAt).toISOString(),
      min,
      items,
    };
  }
}

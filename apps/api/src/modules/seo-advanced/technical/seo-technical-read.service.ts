import { Injectable } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  seoIndexStatusLabel,
  seoInspectionRecent,
  seoNotIndexedReason,
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
}

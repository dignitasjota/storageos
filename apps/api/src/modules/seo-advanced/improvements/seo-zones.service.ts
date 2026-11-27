import { Injectable } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_AREA_GAP_MIN_IMPRESSIONS,
  detectSeoArea,
  seoPlainText,
  type SeoAreaSuggestionDto,
  type SeoAreasDto,
  type SeoOpportunityAreaGapRow,
  type SeoOpportunityQueryRow,
  type UpdateSeoLocalAreasInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoProjectsService, type SeoOwner } from '../seo-projects.service';

/** Páginas del dominio que se miran para saber si una zona ya tiene la suya. */
const MAX_PAGES = 5000;

/**
 * SEO local por municipio (mejora 5): las zonas del proyecto, su propuesta
 * desde los locales y páginas de zona del negocio, y qué zonas se buscan en
 * Google sin tener página propia (alimenta la oportunidad «zona sin página»).
 */
@Injectable()
export class SeoZonesService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
  ) {}

  async get(owner: SeoOwner | undefined, projectId: string): Promise<SeoAreasDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    return {
      projectId,
      areas: project.localAreas,
      suggestions: await this.suggest(project.tenantId, project.localAreas),
    };
  }

  async set(
    owner: SeoOwner,
    projectId: string,
    input: UpdateSeoLocalAreasInput,
  ): Promise<SeoAreasDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    await this.admin.seoProject.updateMany({
      where: { id: projectId, tenantId: project.tenantId },
      data: { localAreas: input.areas },
    });
    return this.get(owner, projectId);
  }

  /** Ciudades de los locales y nombres de las páginas de zona (solo en un tenant). */
  async suggest(
    tenantId: string | null,
    already: readonly string[],
  ): Promise<SeoAreaSuggestionDto[]> {
    if (!tenantId) return [];
    const have = new Set(already.map(seoPlainText));
    const out: SeoAreaSuggestionDto[] = [];
    const seen = new Set<string>();
    const add = (area: string | null | undefined, source: SeoAreaSuggestionDto['source']) => {
      const name = area?.trim();
      if (!name) return;
      const key = seoPlainText(name);
      if (!key || have.has(key) || seen.has(key)) return;
      seen.add(key);
      out.push({ area: name, source });
    };
    const [facilities, pages] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId, deletedAt: null },
        select: { city: true },
      }),
      this.admin.webAreaPage.findMany({
        where: { tenantId, isPublished: true },
        select: { name: true, nearbyAreas: true },
      }),
    ]);
    for (const f of facilities) add(f.city, 'facility');
    for (const p of pages) {
      add(p.name, 'area_page');
      for (const n of p.nearbyAreas) add(n, 'area_page');
    }
    return out.slice(0, 40);
  }

  /**
   * Por cada zona del proyecto, lo que se busca en Google (impresiones de las
   * búsquedas que la nombran) y si el sitio tiene una página para ella: una
   * página con la zona en su dirección o, en un tenant, un local en la ciudad
   * o una página de zona publicada.
   */
  async areaGaps(
    project: { tenantId: string | null; localAreas: string[] },
    domainId: string,
    period: { from: string; to: string },
    queries: readonly SeoOpportunityQueryRow[],
  ): Promise<SeoOpportunityAreaGapRow[]> {
    const areas = project.localAreas;
    if (areas.length === 0) return [];
    const byArea = new Map<
      string,
      { impressions: number; queries: number; best: { query: string; impressions: number } }
    >();
    for (const q of queries) {
      const area = detectSeoArea(q.query, areas);
      if (!area) continue;
      const cur = byArea.get(area) ?? {
        impressions: 0,
        queries: 0,
        best: { query: q.query, impressions: -1 },
      };
      cur.impressions += q.impressions;
      cur.queries += 1;
      if (q.impressions > cur.best.impressions)
        cur.best = { query: q.query, impressions: q.impressions };
      byArea.set(area, cur);
    }
    const wanted = [...byArea.entries()].filter(
      ([, v]) => v.impressions >= SEO_AREA_GAP_MIN_IMPRESSIONS,
    );
    if (wanted.length === 0) return [];
    const pages = await this.admin.$queryRaw<{ page: string }[]>(Prisma.sql`
      SELECT page FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = 'page' AND page <> ''
        AND date BETWEEN ${period.from}::date AND ${period.to}::date
      GROUP BY page ORDER BY SUM(impressions) DESC LIMIT ${MAX_PAGES}`);
    const paths = pages.map((p) => seoPlainText(decodeURIComponentSafe(p.page)));
    const own = await this.ownNames(project.tenantId);
    return wanted.map(([area, v]) => {
      const plain = seoPlainText(area);
      const slug = plain.replace(/ /g, '-');
      const hasPage =
        own.has(plain) ||
        paths.some((p) => p.includes(slug) || p.includes(plain.replace(/ /g, '')));
      return {
        area,
        query: v.best.query,
        impressions: v.impressions,
        queries: v.queries,
        hasPage,
      };
    });
  }

  /** Ciudades de los locales y zonas con página publicada del negocio. */
  private async ownNames(tenantId: string | null): Promise<Set<string>> {
    const names = new Set<string>();
    if (!tenantId) return names;
    const [facilities, pages] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId, deletedAt: null },
        select: { city: true },
      }),
      this.admin.webAreaPage.findMany({
        where: { tenantId, isPublished: true },
        select: { name: true },
      }),
    ]);
    for (const f of facilities) if (f.city) names.add(seoPlainText(f.city));
    for (const p of pages) names.add(seoPlainText(p.name));
    return names;
  }
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

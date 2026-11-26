import { Injectable } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  type SeoCompetitionDomainSummaryDto,
  type SeoCompetitionEvolutionDto,
  type SeoCompetitionGroupDto,
  type SeoCompetitionGroupsDto,
  type SeoCompetitionMoversDto,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoProjectsService, type SeoOwner } from '../seo-projects.service';
import { poolOfProject } from '../sistrix/sistrix-sync.service';

import {
  bestRow,
  buildMovers,
  moverWeight,
  rowBelongs,
  stripWww,
  type SerpRow,
  type TrackedDomain,
} from './seo-competition.logic';

const MAX_ITEMS = 100;
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

interface RawRow {
  keyword_id: string;
  rk: number;
  sample_date: Date;
  position: number;
  domain: string;
  url: string;
  title: string | null;
}

/**
 * La competencia con lo que ya se guarda de Google (`seo_serp_results`):
 * quién sube y quién baja entre las dos últimas muestras, la comparativa por
 * grupo de palabras y la evolución de un competidor en una palabra (mejora 4).
 */
@Injectable()
export class SeoCompetitionService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
  ) {}

  private async context(owner: SeoOwner | undefined, projectId: string) {
    const project = await this.projects.resolveProject(owner, projectId);
    const competitors = await this.admin.seoCompetitor.findMany({
      where: { projectId, isActive: true },
    });
    const domains: TrackedDomain[] = [
      ...project.domains
        .filter((d) => d.role !== 'redirect')
        .map((d) => ({ domain: stripWww(d.domain), own: true, pathPrefix: null })),
      ...competitors.map((c) => ({
        domain: stripWww(c.domain),
        own: false,
        pathPrefix: c.pathPrefix,
      })),
    ];
    const keywordRows = await this.admin.seoProjectKeyword.findMany({
      where: { projectId, isActive: true },
      include: { keyword: { select: { keyword: true } } },
    });
    const keywords = new Map(
      keywordRows.map((k) => [k.keywordId, { keyword: k.keyword.keyword, group: k.groupName }]),
    );
    return { project, domains, keywords, pool: poolOfProject(project) };
  }

  /** Las `samples` últimas muestras de cada palabra de las seguidas (de los dominios que se miran). */
  private async serpRows(
    pool: string | null,
    country: string,
    keywordIds: string[],
    domains: TrackedDomain[],
    samples: number,
  ): Promise<SerpRow[]> {
    if (keywordIds.length === 0 || domains.length === 0) return [];
    const tenant = pool ? Prisma.sql`tenant_id = ${pool}::uuid` : Prisma.sql`tenant_id IS NULL`;
    const names = [...new Set(domains.map((d) => d.domain))];
    const rows = await this.admin.$queryRaw<RawRow[]>(Prisma.sql`
      WITH d AS (
        SELECT DISTINCT keyword_id, sample_date FROM seo_serp_results
        WHERE ${tenant} AND country = ${country} AND keyword_id = ANY(${keywordIds}::uuid[])
      ), ranked AS (
        SELECT keyword_id, sample_date,
          DENSE_RANK() OVER (PARTITION BY keyword_id ORDER BY sample_date DESC) AS rk
        FROM d
      )
      SELECT r.keyword_id, k.rk::int AS rk, r.sample_date, r.position, r.domain, r.url, r.title
      FROM seo_serp_results r
      JOIN ranked k ON k.keyword_id = r.keyword_id AND k.sample_date = r.sample_date
      WHERE ${tenant} AND r.country = ${country} AND k.rk <= ${samples}
        AND regexp_replace(lower(r.domain), '^www\\.', '') = ANY(${names}::text[])`);
    return rows.map((r) => ({
      keywordId: r.keyword_id,
      rank: Number(r.rk),
      sampleDate: dateOnly(r.sample_date),
      position: Number(r.position),
      domain: r.domain,
      url: r.url,
      title: r.title,
    }));
  }

  async movers(owner: SeoOwner | undefined, projectId: string): Promise<SeoCompetitionMoversDto> {
    const ctx = await this.context(owner, projectId);
    const rows = await this.serpRows(
      ctx.pool,
      ctx.project.country.toLowerCase(),
      [...ctx.keywords.keys()],
      ctx.domains,
      2,
    );
    const built = buildMovers({ rows, domains: ctx.domains, keywords: ctx.keywords });
    const summary: SeoCompetitionDomainSummaryDto[] = ctx.domains.map((d) => {
      const mine = built.items.filter((i) => i.domain === d.domain);
      return {
        domain: d.domain,
        own: d.own,
        up: mine.filter((i) => i.diff !== null && i.diff > 0).length,
        down: mine.filter((i) => i.diff !== null && i.diff < 0).length,
        entered: mine.filter((i) => i.previous === null).length,
        left: mine.filter((i) => i.current === null).length,
      };
    });
    return {
      projectId,
      from: built.from,
      to: built.to,
      summary,
      items: built.items
        .sort((a, b) => moverWeight(b) - moverWeight(a) || a.keyword.localeCompare(b.keyword))
        .slice(0, MAX_ITEMS),
      withoutHistory: built.withoutHistory,
    };
  }

  async groups(owner: SeoOwner | undefined, projectId: string): Promise<SeoCompetitionGroupsDto> {
    const ctx = await this.context(owner, projectId);
    const rows = await this.serpRows(
      ctx.pool,
      ctx.project.country.toLowerCase(),
      [...ctx.keywords.keys()],
      ctx.domains,
      1,
    );
    const sampled = new Set(rows.map((r) => r.keywordId));
    // Una palabra con muestra pero sin resultados de nuestros dominios sigue contando: se mira aparte.
    const sampledAny = await this.sampledKeywords(ctx.pool, ctx.project.country.toLowerCase(), [
      ...ctx.keywords.keys(),
    ]);
    const groupNames = [...new Set([...ctx.keywords.values()].map((k) => k.group))].sort((a, b) =>
      (a ?? '￿').localeCompare(b ?? '￿'),
    );
    const groups: SeoCompetitionGroupDto[] = groupNames.map((group) => {
      const ids = [...ctx.keywords.entries()]
        .filter(([, k]) => k.group === group)
        .map(([id]) => id);
      return {
        group,
        keywords: ids.length,
        sampled: ids.filter((id) => sampled.has(id) || sampledAny.has(id)).length,
        cells: ctx.domains.map((d) => {
          const positions: number[] = [];
          for (const id of ids) {
            const best = bestRow(
              rows.filter((r) => r.keywordId === id),
              d,
            );
            if (best) positions.push(best.position);
          }
          return {
            domain: d.domain,
            own: d.own,
            appears: positions.length,
            averagePosition: positions.length
              ? Math.round((positions.reduce((s, p) => s + p, 0) / positions.length) * 10) / 10
              : null,
            best: positions.length ? Math.min(...positions) : null,
          };
        }),
      };
    });
    return { projectId, groups };
  }

  private async sampledKeywords(
    pool: string | null,
    country: string,
    ids: string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.admin.seoSerpResult.findMany({
      where: { tenantId: pool, country, keywordId: { in: ids } },
      distinct: ['keywordId'],
      select: { keywordId: true },
    });
    return new Set(rows.map((r) => r.keywordId));
  }

  async evolution(
    owner: SeoOwner | undefined,
    projectId: string,
    domainRaw: string,
    projectKeywordId: string,
  ): Promise<SeoCompetitionEvolutionDto> {
    const ctx = await this.context(owner, projectId);
    const pk = await this.admin.seoProjectKeyword.findFirst({
      where: { id: projectKeywordId, projectId },
      select: { keywordId: true },
    });
    const keywordId = pk?.keywordId ?? '';
    const domain = ctx.domains.find((d) => d.domain === stripWww(domainRaw));
    const keyword = ctx.keywords.get(keywordId);
    if (!domain || !keyword) {
      return {
        keyword: keyword?.keyword ?? '',
        domain: stripWww(domainRaw),
        own: false,
        mine: [],
        points: [],
      };
    }
    const own = ctx.domains.filter((d) => d.own);
    const rows = await this.serpRows(
      ctx.pool,
      ctx.project.country.toLowerCase(),
      [keywordId],
      ctx.domains,
      60,
    );
    const dates = [...new Set(rows.map((r) => r.sampleDate))].sort();
    // Las muestras sin ningún resultado nuestro también cuentan como fecha (el dominio no salía).
    const all = await this.admin.seoSerpResult.findMany({
      where: { tenantId: ctx.pool, keywordId, country: ctx.project.country.toLowerCase() },
      distinct: ['sampleDate'],
      select: { sampleDate: true },
      orderBy: { sampleDate: 'asc' },
      take: 60,
    });
    const every = [...new Set([...dates, ...all.map((a) => dateOnly(a.sampleDate))])].sort();
    return {
      keyword: keyword.keyword,
      domain: domain.domain,
      own: domain.own,
      mine: every.map((date) => ({
        date,
        position:
          own
            .map((o) =>
              bestRow(
                rows.filter((r) => r.sampleDate === date),
                o,
              ),
            )
            .filter((r): r is SerpRow => !!r)
            .sort((a, b) => a.position - b.position)[0]?.position ?? null,
      })),
      points: every.map((date) => {
        const r = bestRow(
          rows.filter((x) => x.sampleDate === date && rowBelongs(x, domain)),
          domain,
        );
        return {
          date,
          position: r?.position ?? null,
          url: r?.url ?? null,
          title: r?.title ?? null,
        };
      }),
    };
  }
}

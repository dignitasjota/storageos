import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  detectSeoOpportunities,
  normalizeSeoKeyword,
  seoPeriodCovered,
  seoPeriodRange,
  seoSistrixIntent,
  seoThresholdsOf,
  seoTotalsFromSums,
  seoWeightsOf,
  type SeoKeywordIntent,
  type SeoOpportunityCandidate,
  type SeoOpportunityGapRow,
  type SeoOpportunityKeywordRow,
  type SeoOpportunityQueryRow,
  type SeoOpportunityRecalcDto,
  type SeoOpportunitySistrixRow,
  type SeoOpportunityThresholds,
  type SeoProviderKey,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { poolOfProject } from '../sistrix/sistrix-sync.service';

const today = () => new Date().toISOString().slice(0, 10);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Búsquedas como mucho por dominio y cálculo (las de más impresiones y tus palabras). */
const MAX_QUERIES = 3000;
/** Palabras de competidores que se miran como mucho. */
const MAX_GAP_ROWS = 1000;
/** Días hacia atrás que cuentan como «tu web ya sale» para la competencia. */
const OWN_QUERY_DAYS = 90;

interface SumsWithPrevRow {
  key: string;
  c: number | null;
  i: number | null;
  w: number | null;
  ps: number | null;
  n: number | null;
  pc: number | null;
  pi: number | null;
  pw: number | null;
  pps: number | null;
  pn: number | null;
}

const sums = (
  c: number | null,
  i: number | null,
  w: number | null,
  ps: number | null,
  n: number | null,
) => ({
  clicks: Number(c ?? 0),
  impressions: Number(i ?? 0),
  weightedPosition: Number(w ?? 0),
  positionSum: Number(ps ?? 0),
  rows: Number(n ?? 0),
});

/**
 * Motor de oportunidades (PR 4). Reúne con agregaciones SQL lo de cada
 * dominio (búsquedas del periodo y del anterior, tus palabras, métricas y
 * oportunidades de SISTRIX, palabras de los competidores), decide qué es una
 * oportunidad con las reglas puras de `@storageos/shared` y lo guarda sin
 * pisar estado, notas ni asignación.
 */
@Injectable()
export class SeoOpportunityEngineService {
  private readonly logger = new Logger(SeoOpportunityEngineService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  /** Recalcula las oportunidades de un proyecto (null si ya no existe). */
  async recalculate(projectId: string): Promise<SeoOpportunityRecalcDto | null> {
    const project = await this.admin.seoProject.findUnique({
      where: { id: projectId },
      include: { domains: { orderBy: { createdAt: 'asc' } }, competitors: true },
    });
    if (!project) return null;
    const weights = seoWeightsOf(project.weights);
    const thresholds = seoThresholdsOf(project.opportunitySettings);
    const pool = poolOfProject(project);
    const country = project.country.toLowerCase();
    const domains = project.domains.filter((d) => d.role !== 'redirect');
    const primary = domains.find((d) => d.role === 'primary') ?? domains[0] ?? null;

    const catalogRows = await this.admin.seoProjectKeyword.findMany({
      where: { projectId, isActive: true },
      include: { keyword: { select: { keyword: true } } },
    });
    const catalogWords = catalogRows.map((r) => normalizeSeoKeyword(r.keyword.keyword));

    // 1) Lo de cada dominio: búsquedas de Search Console y oportunidades de SISTRIX.
    const perDomain: {
      domain: (typeof domains)[number];
      period: {
        from: string;
        to: string;
        previousFrom: string;
        previousTo: string;
        comparable: boolean;
      };
      queries: SeoOpportunityQueryRow[];
      sistrix: SeoOpportunitySistrixRow[];
      gaps: SeoOpportunityGapRow[];
    }[] = [];
    for (const d of domains) {
      const period = await this.period(d.id, thresholds);
      const queries = period.hasData
        ? await this.queries(d.id, period, thresholds, catalogWords)
        : [];
      const sistrix = await this.sistrixOpportunities(pool, country, d.domain);
      const gaps =
        primary && d.id === primary.id
          ? await this.keywordGaps({
              pool,
              country,
              ownDomainIds: domains.map((x) => x.id),
              ownDomains: domains.map((x) => x.domain),
              competitors: project.competitors.filter((c) => c.isActive).map((c) => c.domain),
              maxPosition: thresholds.keywordGapMaxPosition,
            })
          : [];
      perDomain.push({ domain: d, period, queries, sistrix, gaps });
    }

    // 2) Métricas de SISTRIX de todas las palabras que salen (una consulta).
    const words = new Set<string>(catalogWords);
    for (const p of perDomain) {
      for (const q of p.queries) words.add(normalizeSeoKeyword(q.query));
      for (const s of p.sistrix) words.add(normalizeSeoKeyword(s.keyword));
      for (const g of p.gaps) words.add(normalizeSeoKeyword(g.keyword));
    }
    const metrics = await this.keywordMetrics(pool, country, [...words]);
    const catalog = new Map(catalogRows.map((r) => [normalizeSeoKeyword(r.keyword.keyword), r]));
    const keywordRows: SeoOpportunityKeywordRow[] = [];
    for (const w of words) {
      const c = catalog.get(w);
      const m = metrics.get(w) ?? null;
      if (!c && !m) continue;
      keywordRows.push({
        keyword: w,
        inCatalog: !!c,
        intent: (c?.intent as SeoKeywordIntent | null) ?? null,
        priority: c?.priority ?? null,
        targetUrl: c?.targetUrl ?? null,
        metrics: m,
      });
    }
    const sistrixMetricsAvailable = catalogWords.some((w) => metrics.has(w));

    // 3) Las reglas.
    const candidates: (SeoOpportunityCandidate & { domainId: string })[] = [];
    for (const p of perDomain) {
      const found = detectSeoOpportunities({
        domain: p.domain.domain,
        brandTerms: project.brandTerms,
        weights,
        thresholds,
        period: p.period,
        queries: p.queries,
        keywords: keywordRows,
        sistrixMetricsAvailable,
        sistrixOpportunities: p.sistrix,
        keywordGaps: p.gaps,
      });
      const pages = await this.topPages(
        p.domain.id,
        p.period,
        found.filter((f) => f.metrics.gsc).map((f) => f.query),
      );
      for (const f of found) {
        candidates.push({
          ...f,
          page: pages.get(f.query) ?? f.metrics.sistrix?.url ?? null,
          domainId: p.domain.id,
        });
      }
    }

    // 4) Guardar sin pisar estado, notas ni asignación.
    return this.store(project.id, project.tenantId, candidates, thresholds);
  }

  // ---------------------------------------------------------------- datos

  private async period(domainId: string, t: SeoOpportunityThresholds) {
    const b = await this.admin.seoGscMetric.aggregate({
      where: { domainId, grain: 'site' },
      _min: { date: true },
      _max: { date: true },
    });
    const last = dateOnly(b._max.date);
    const range = seoPeriodRange(last ?? today(), t.periodDays);
    if (!last) return { ...range, comparable: false, hasData: false };
    const prevRows = await this.admin.seoGscMetric.count({
      where: {
        domainId,
        grain: 'site',
        date: {
          gte: new Date(`${range.previousFrom}T00:00:00Z`),
          lte: new Date(`${range.previousTo}T00:00:00Z`),
        },
      },
    });
    return {
      ...range,
      comparable: seoPeriodCovered({
        firstDate: dateOnly(b._min.date),
        from: range.previousFrom,
        to: range.previousTo,
        daysWithData: prevRows,
      }),
      hasData: true,
    };
  }

  /**
   * Búsquedas del periodo (con un mínimo de impresiones, o de tus palabras) y
   * sus sumas en el periodo anterior: todo sumado por la base de datos.
   */
  private async queries(
    domainId: string,
    period: {
      from: string;
      to: string;
      previousFrom: string;
      previousTo: string;
      comparable: boolean;
    },
    t: SeoOpportunityThresholds,
    catalog: string[],
  ): Promise<SeoOpportunityQueryRow[]> {
    const min = Math.max(
      1,
      Math.min(
        t.minImpressions,
        t.commercialMinImpressions,
        t.lowCtrMinImpressions,
        t.trendMinImpressions,
        t.demandGapMinImpressions,
      ),
    );
    const rows = await this.admin.$queryRaw<SumsWithPrevRow[]>(Prisma.sql`
      WITH cur AS (
        SELECT query AS key,
          SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
          SUM(position * impressions)::float8 AS w, SUM(position)::float8 AS ps,
          COUNT(*)::float8 AS n
        FROM seo_gsc_metrics
        WHERE domain_id = ${domainId}::uuid AND grain = 'query' AND query <> ''
          AND date BETWEEN ${period.from}::date AND ${period.to}::date
        GROUP BY query
        HAVING SUM(impressions) >= ${min} OR query = ANY(${catalog}::text[])
        ORDER BY (query = ANY(${catalog}::text[])) DESC, SUM(impressions) DESC
        LIMIT ${MAX_QUERIES}
      ), prev AS (
        SELECT query AS key,
          SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
          SUM(position * impressions)::float8 AS w, SUM(position)::float8 AS ps,
          COUNT(*)::float8 AS n
        FROM seo_gsc_metrics
        WHERE domain_id = ${domainId}::uuid AND grain = 'query'
          AND date BETWEEN ${period.previousFrom}::date AND ${period.previousTo}::date
          AND query IN (SELECT key FROM cur)
        GROUP BY query
      )
      SELECT cur.key, cur.c, cur.i, cur.w, cur.ps, cur.n,
        prev.c AS pc, prev.i AS pi, prev.w AS pw, prev.ps AS pps, prev.n AS pn
      FROM cur LEFT JOIN prev ON prev.key = cur.key`);
    return rows.map((r) => {
      const cur = seoTotalsFromSums(sums(r.c, r.i, r.w, r.ps, r.n));
      const prevSums = sums(r.pc, r.pi, r.pw, r.pps, r.pn);
      const prev = prevSums.rows > 0 ? seoTotalsFromSums(prevSums) : null;
      return {
        query: r.key,
        clicks: cur.clicks,
        impressions: cur.impressions,
        position: cur.position,
        previous:
          period.comparable && prev
            ? { clicks: prev.clicks, impressions: prev.impressions, position: prev.position }
            : null,
      };
    });
  }

  /** Última muestra de las oportunidades de SISTRIX del dominio (en el fondo del proyecto). */
  private async sistrixOpportunities(
    pool: string | null,
    country: string,
    domain: string,
  ): Promise<SeoOpportunitySistrixRow[]> {
    const latest = await this.admin.seoDomainOpportunity.findFirst({
      where: { tenantId: pool, domain, country, kind: 'opportunity' },
      orderBy: { sampleDate: 'desc' },
    });
    if (!latest) return [];
    const rows = await this.admin.seoDomainOpportunity.findMany({
      where: {
        tenantId: pool,
        domain,
        country,
        kind: 'opportunity',
        sampleDate: latest.sampleDate,
        provider: latest.provider,
      },
      take: 500,
    });
    return rows.map((r) => ({
      keyword: r.keyword,
      position: r.position,
      url: r.url,
      gain: r.gain,
      competition: r.competition,
      traffic: r.traffic,
      origin: {
        provider: r.provider as SeoProviderKey,
        fetchedAt: r.fetchedAt.toISOString(),
        dataDate: dateOnly(r.sampleDate),
      },
    }));
  }

  /**
   * Palabras en las que un competidor seguido sale en el top N y tu web no:
   * ni en Search Console (90 días, cualquier dominio del proyecto) ni en las
   * palabras de tus dominios según SISTRIX. El cruce lo hace la base de datos.
   */
  private async keywordGaps(input: {
    pool: string | null;
    country: string;
    ownDomainIds: string[];
    ownDomains: string[];
    competitors: string[];
    maxPosition: number;
  }): Promise<SeoOpportunityGapRow[]> {
    if (input.competitors.length === 0) return [];
    const since = new Date(Date.now() - OWN_QUERY_DAYS * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.admin.$queryRaw<
      {
        keyword: string;
        domain: string;
        position: number;
        url: string;
        provider: string;
        fetched: Date;
        sample: Date;
      }[]
    >(Prisma.sql`
      WITH latest AS (
        SELECT domain, MAX(sample_date) AS d FROM seo_domain_keywords
        WHERE tenant_id IS NOT DISTINCT FROM ${input.pool}::uuid AND country = ${input.country}
          AND domain = ANY(${input.competitors}::text[])
        GROUP BY domain
      ), own_q AS (
        SELECT DISTINCT query FROM seo_gsc_metrics
        WHERE domain_id = ANY(${input.ownDomainIds}::uuid[]) AND grain = 'query'
          AND date >= ${since}::date AND impressions > 0
      ), own_s AS (
        SELECT DISTINCT lower(keyword) AS keyword FROM seo_domain_keywords
        WHERE tenant_id IS NOT DISTINCT FROM ${input.pool}::uuid AND country = ${input.country}
          AND domain = ANY(${input.ownDomains}::text[])
      )
      SELECT lower(k.keyword) AS keyword, k.domain, MIN(k.position)::int AS position,
        MIN(k.url) AS url, MIN(k.provider) AS provider,
        MAX(k.fetched_at) AS fetched, MAX(k.sample_date) AS sample
      FROM seo_domain_keywords k
      JOIN latest l ON l.domain = k.domain AND l.d = k.sample_date
      LEFT JOIN own_q ON own_q.query = lower(k.keyword)
      LEFT JOIN own_s ON own_s.keyword = lower(k.keyword)
      WHERE k.tenant_id IS NOT DISTINCT FROM ${input.pool}::uuid AND k.country = ${input.country}
        AND k.position <= ${input.maxPosition}
        AND own_q.query IS NULL AND own_s.keyword IS NULL
      GROUP BY lower(k.keyword), k.domain
      ORDER BY MIN(k.position) ASC
      LIMIT ${MAX_GAP_ROWS}`);
    const byKeyword = new Map<string, SeoOpportunityGapRow>();
    for (const r of rows) {
      const origin = {
        provider: r.provider as SeoProviderKey,
        fetchedAt: new Date(r.fetched).toISOString(),
        dataDate: dateOnly(new Date(r.sample)),
      };
      const g = byKeyword.get(r.keyword) ?? { keyword: r.keyword, competitors: [], origin };
      g.competitors.push({ domain: r.domain, position: Number(r.position), url: r.url });
      if (origin.fetchedAt > g.origin.fetchedAt) g.origin = origin;
      byKeyword.set(r.keyword, g);
    }
    return [...byKeyword.values()];
  }

  /**
   * Últimas métricas de SISTRIX de cada palabra (en el fondo del proyecto).
   * También las usa la vista de palabras seguidas (volumen e intención).
   */
  async keywordMetrics(
    pool: string | null,
    country: string,
    words: string[],
  ): Promise<Map<string, NonNullable<SeoOpportunityKeywordRow['metrics']>>> {
    if (words.length === 0) return new Map();
    const rows = await this.admin.$queryRaw<
      {
        keyword: string;
        traffic: number | null;
        competition: number | null;
        cpc: number | null;
        know: number | null;
        do: number | null;
        visit: number | null;
        website: number | null;
        provider: string;
        fetched_at: Date;
        data_date: Date | null;
      }[]
    >(Prisma.sql`
      SELECT DISTINCT ON (sk.keyword) sk.keyword, km.traffic, km.competition,
        km.cpc::float8 AS cpc, km.intent_know AS know, km.intent_do AS "do",
        km.intent_visit AS visit, km.intent_website AS website,
        km.provider, km.fetched_at, km.data_date
      FROM seo_keyword_metrics km JOIN seo_keywords sk ON sk.id = km.keyword_id
      WHERE km.tenant_id IS NOT DISTINCT FROM ${pool}::uuid AND km.country = ${country}
        AND sk.keyword = ANY(${words}::text[])
      ORDER BY sk.keyword, km.fetched_at DESC`);
    return new Map(
      rows.map((r) => [
        r.keyword,
        {
          volume: r.traffic,
          competition: r.competition,
          cpc: r.cpc === null ? null : Number(r.cpc),
          intent: seoSistrixIntent({ know: r.know, do: r.do, visit: r.visit, website: r.website }),
          origin: {
            provider: r.provider as SeoProviderKey,
            fetchedAt: new Date(r.fetched_at).toISOString(),
            dataDate: r.data_date ? dateOnly(new Date(r.data_date)) : null,
          },
        },
      ]),
    );
  }

  /** La página que más clics (y luego impresiones) recibe por cada búsqueda. */
  private async topPages(
    domainId: string,
    period: { from: string; to: string },
    queries: string[],
  ): Promise<Map<string, string>> {
    if (queries.length === 0) return new Map();
    const rows = await this.admin.$queryRaw<{ query: string; page: string }[]>(Prisma.sql`
      SELECT DISTINCT ON (query) query, page FROM (
        SELECT query, page, SUM(clicks) AS c, SUM(impressions) AS i
        FROM seo_gsc_metrics
        WHERE domain_id = ${domainId}::uuid AND grain = 'query_page'
          AND date BETWEEN ${period.from}::date AND ${period.to}::date
          AND query = ANY(${[...new Set(queries)]}::text[])
        GROUP BY query, page
      ) t
      ORDER BY query, c DESC, i DESC, page ASC`);
    return new Map(rows.map((r) => [r.query, r.page]));
  }

  // -------------------------------------------------------------- guardar

  private async store(
    projectId: string,
    tenantId: string | null,
    candidates: (SeoOpportunityCandidate & { domainId: string })[],
    t: SeoOpportunityThresholds,
  ): Promise<SeoOpportunityRecalcDto> {
    const now = new Date();
    const records = candidates.map((c) => ({
      domain_id: c.domainId,
      domain: c.domain,
      type: c.type,
      key: createHash('sha1').update(c.key).digest('hex'),
      query: c.query,
      page: c.page,
      target_url: c.targetUrl,
      score: c.score,
      confidence: c.confidence,
      factors: c.factors,
      metrics: c.metrics,
      sources: c.sources,
      reason: c.reason,
      action: c.action,
    }));
    // Dos cálculos del mismo proyecto no se mezclan.
    const result = await this.admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seo-opp:${projectId}`}::text))`;
        const back = (rec: Prisma.Sql) => Prisma.sql`seo_opportunities.status = 'dismissed'
          AND ${rec}.score >= COALESCE(seo_opportunities.dismissed_score, 0) + ${t.reappearPoints}`;
        const returned = back(Prisma.raw('EXCLUDED'));
        const upserted =
          records.length === 0
            ? []
            : await tx.$queryRaw<{ inserted: boolean; returned: boolean }[]>(Prisma.sql`
          INSERT INTO seo_opportunities (
            tenant_id, project_id, domain_id, domain, type, key, query, page, target_url,
            score, confidence, factors, metrics, sources, reason, action,
            active, detected_at, last_seen_at, created_at, updated_at
          )
          SELECT ${tenantId}::uuid, ${projectId}::uuid, x.domain_id::uuid, x.domain, x.type, x.key,
            x.query, x.page, x.target_url, x.score, x.confidence, x.factors, x.metrics,
            ARRAY(SELECT jsonb_array_elements_text(x.sources)), x.reason, x.action,
            true, ${now}, ${now}, ${now}, ${now}
          FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS x(
            domain_id text, domain text, type text, key text, query text, page text,
            target_url text, score int, confidence numeric, factors jsonb, metrics jsonb,
            sources jsonb, reason text, action text
          )
          ON CONFLICT (project_id, key) DO UPDATE SET
            domain_id = EXCLUDED.domain_id,
            domain = EXCLUDED.domain,
            page = EXCLUDED.page,
            target_url = EXCLUDED.target_url,
            score = EXCLUDED.score,
            confidence = EXCLUDED.confidence,
            factors = EXCLUDED.factors,
            metrics = EXCLUDED.metrics,
            sources = EXCLUDED.sources,
            reason = EXCLUDED.reason,
            action = EXCLUDED.action,
            active = true,
            last_seen_at = EXCLUDED.last_seen_at,
            updated_at = EXCLUDED.updated_at,
            status = CASE WHEN ${returned} THEN 'new' ELSE seo_opportunities.status END,
            returned_at = CASE WHEN ${returned} THEN EXCLUDED.last_seen_at
              ELSE seo_opportunities.returned_at END,
            dismiss_reason = CASE WHEN ${returned} THEN NULL ELSE seo_opportunities.dismiss_reason END,
            dismissed_score = CASE WHEN ${returned} THEN NULL ELSE seo_opportunities.dismissed_score END,
            resolved_at = CASE WHEN ${returned} THEN NULL ELSE seo_opportunities.resolved_at END
          RETURNING (xmax = 0) AS inserted, (returned_at = ${now}) AS returned`);
        const gone = await tx.$executeRaw`
          UPDATE seo_opportunities SET active = false, updated_at = ${now}
          WHERE project_id = ${projectId}::uuid AND active AND last_seen_at < ${now}`;
        await tx.seoProject.update({
          where: { id: projectId },
          data: { opportunitiesCalculatedAt: now },
        });
        return {
          created: upserted.filter((r) => r.inserted).length,
          returned: upserted.filter((r) => !r.inserted && r.returned).length,
          gone,
        };
      },
      { timeout: 60_000 },
    );
    this.logger.log(
      `Oportunidades de ${projectId}: ${records.length} detectadas, ${result.created} nuevas, ${result.returned} vuelven, ${result.gone} ya no salen`,
    );
    return { calculatedAt: now.toISOString(), detected: records.length, ...result };
  }
}

import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  analyzeSeoCannibalization,
  detectSeoIndexFindings,
  matchSeoIndexRule,
  normalizeSeoKeyword,
  seoDiagnosticSettingsOf,
  seoPeriodRange,
  type SeoCannibalizationCandidate,
  type SeoCannibalizationThresholds,
  type SeoDailyPageRow,
  type SeoDiagnosticsRecalcDto,
  type SeoIndexFindingCandidate,
  type SeoPageMetric,
  type SeoSitemapsDto,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SearchConsoleClient } from '../../search-console/search-console.client';

const today = () => new Date().toISOString().slice(0, 10);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Búsquedas que se miran como mucho por dominio (las de más impresiones). */
const MAX_CANNIBAL_QUERIES = 2000;
/** Páginas con impresiones que se repasan como mucho por dominio. */
const MAX_INDEX_PAGES = 50_000;

type Counts = SeoDiagnosticsRecalcDto['index'];

/**
 * Diagnóstico de un proyecto (PR 5): canibalización (cruce consulta + página
 * del periodo y la página ganadora de cada día) y páginas que aparecen en
 * Google y no deberían (cruce página de todo lo guardado contra las reglas
 * del proyecto). Suma con SQL, decide con las funciones puras de
 * `@storageos/shared` y guarda sin pisar estado ni notas. Se recalcula tras
 * cada descarga de Search Console (en el trabajo de oportunidades), al
 * cambiar los ajustes y con «Recalcular ahora».
 */
/** Días que Google tiene para retirar o asentar lo arreglado antes de darlo por vuelto. */
const FIXED_RETURN_MARGIN_DAYS = 28;

@Injectable()
export class SeoDiagnosticsEngineService {
  private readonly logger = new Logger(SeoDiagnosticsEngineService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly client: SearchConsoleClient,
  ) {}

  async recalculate(projectId: string): Promise<SeoDiagnosticsRecalcDto | null> {
    const project = await this.admin.seoProject.findUnique({
      where: { id: projectId },
      include: { domains: { orderBy: { createdAt: 'asc' } } },
    });
    if (!project) return null;
    const settings = seoDiagnosticSettingsOf(project.diagnosticSettings);
    const catalog = await this.admin.seoProjectKeyword.findMany({
      where: { projectId, targetUrl: { not: null } },
      include: { keyword: { select: { keyword: true } } },
    });
    const targets = new Map(
      catalog.map((c) => [normalizeSeoKeyword(c.keyword.keyword), c.targetUrl as string]),
    );

    const cannibal: (SeoCannibalizationCandidate & {
      domainId: string;
      domain: string;
      from: string;
      to: string;
    })[] = [];
    const index: (SeoIndexFindingCandidate & { domainId: string; domain: string })[] = [];
    for (const d of project.domains) {
      const redirect = d.role === 'redirect';
      if (!redirect) {
        const found = await this.cannibalization(
          d.id,
          settings.cannibalization,
          project.brandTerms,
          targets,
        );
        for (const c of found.items) {
          cannibal.push({ ...c, domainId: d.id, domain: d.domain, from: found.from, to: found.to });
        }
      }
      const pages = await this.indexPages(d.id);
      for (const f of detectSeoIndexFindings({
        pages,
        rules: settings.indexRules,
        redirectDomain: redirect,
      })) {
        index.push({ ...f, domainId: d.id, domain: d.domain });
      }
    }
    return this.store(project.id, project.tenantId, cannibal, index);
  }

  // ---------------------------------------------------------------- datos

  private async cannibalization(
    domainId: string,
    t: SeoCannibalizationThresholds,
    brandTerms: string[],
    targets: Map<string, string>,
  ): Promise<{ from: string; to: string; items: SeoCannibalizationCandidate[] }> {
    const last = await this.admin.seoGscMetric.aggregate({
      where: { domainId, grain: 'query_page' },
      _max: { date: true },
    });
    const range = seoPeriodRange(dateOnly(last._max.date) ?? today(), t.periodDays);
    if (!last._max.date) return { from: range.from, to: range.to, items: [] };
    const rows = await this.admin.$queryRaw<
      { query: string; page: string; c: number; i: number; w: number; ps: number; n: number }[]
    >(Prisma.sql`
      WITH q AS (
        SELECT query, page, SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
          SUM(position * impressions)::float8 AS w, SUM(position)::float8 AS ps,
          COUNT(*)::float8 AS n
        FROM seo_gsc_metrics
        WHERE domain_id = ${domainId}::uuid AND grain = 'query_page' AND query <> ''
          AND page <> '' AND date BETWEEN ${range.from}::date AND ${range.to}::date
        GROUP BY query, page
      ), t AS (
        SELECT query FROM q GROUP BY query
        HAVING SUM(i) >= ${t.minImpressions}
          AND COUNT(*) FILTER (WHERE i >= ${t.minPageImpressions}) >= 2
        ORDER BY SUM(i) DESC LIMIT ${MAX_CANNIBAL_QUERIES}
      )
      SELECT q.* FROM q JOIN t USING (query)`);
    const byQuery = new Map<string, SeoPageMetric[]>();
    for (const r of rows) {
      const i = Number(r.i);
      const list = byQuery.get(r.query) ?? [];
      list.push({
        page: r.page,
        clicks: Number(r.c),
        impressions: i,
        position: Number(r.n) > 0 ? (i > 0 ? Number(r.w) / i : Number(r.ps) / Number(r.n)) : null,
      });
      byQuery.set(r.query, list);
    }
    // Primero sin días (descarta marca, variantes y segundas páginas pequeñas).
    const candidates = [...byQuery.entries()].filter(
      ([query, pages]) =>
        analyzeSeoCannibalization({
          query,
          brandTerms,
          pages,
          daily: [],
          targetUrl: targets.get(normalizeSeoKeyword(query)) ?? null,
          thresholds: t,
        }) !== null,
    );
    if (candidates.length === 0) return { from: range.from, to: range.to, items: [] };
    const daily = await this.admin.$queryRaw<
      { query: string; date: Date; page: string; c: number; i: number }[]
    >(Prisma.sql`
      SELECT query, date, page, SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i
      FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = 'query_page'
        AND query = ANY(${candidates.map(([q]) => q)}::text[])
        AND date BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY query, date, page`);
    const dailyBy = new Map<string, SeoDailyPageRow[]>();
    for (const r of daily) {
      const list = dailyBy.get(r.query) ?? [];
      list.push({
        date: dateOnly(new Date(r.date))!,
        page: r.page,
        clicks: Number(r.c),
        impressions: Number(r.i),
      });
      dailyBy.set(r.query, list);
    }
    const items: SeoCannibalizationCandidate[] = [];
    for (const [query, pages] of candidates) {
      const c = analyzeSeoCannibalization({
        query,
        brandTerms,
        pages,
        daily: dailyBy.get(query) ?? [],
        targetUrl: targets.get(normalizeSeoKeyword(query)) ?? null,
        thresholds: t,
      });
      if (c) items.push(c);
    }
    return { from: range.from, to: range.to, items };
  }

  /** Cada página con impresiones en todo lo guardado (cruce `page`), con su primer y último día. */
  private async indexPages(domainId: string) {
    const rows = await this.admin.$queryRaw<
      { page: string; c: number; i: number; f: Date; l: Date }[]
    >(Prisma.sql`
      SELECT page, SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
        MIN(date) AS f, MAX(date) AS l
      FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = 'page' AND page <> ''
        AND impressions > 0
      GROUP BY page
      ORDER BY SUM(impressions) DESC
      LIMIT ${MAX_INDEX_PAGES}`);
    return rows.map((r) => ({
      page: r.page,
      clicks: Number(r.c),
      impressions: Number(r.i),
      firstDate: dateOnly(new Date(r.f))!,
      lastDate: dateOnly(new Date(r.l))!,
    }));
  }

  /**
   * Los mapas del sitio enviados a Google de cada dominio (enviadas, avisos y
   * errores, de la API de Search Console). No se descarga el XML de cada mapa:
   * sería una petición a una dirección que pone el cliente desde nuestro
   * servidor, y la inspección de URL ya llega en la fase 4.
   */
  async sitemaps(
    domains: { id: string; domain: string; gscProperty: string; connectionStatus: string }[],
    rules: string[],
  ): Promise<SeoSitemapsDto> {
    const out: SeoSitemapsDto['domains'] = [];
    for (const d of domains) {
      if (d.connectionStatus !== 'connected') {
        out.push({
          domainId: d.id,
          domain: d.domain,
          error: 'El dominio aún no está conectado con Search Console.',
          sitemaps: [],
        });
        continue;
      }
      try {
        const list = await this.client.listSitemaps(d.gscProperty);
        out.push({
          domainId: d.id,
          domain: d.domain,
          error: null,
          sitemaps: list.map((m) => ({
            path: m.path,
            lastSubmitted: m.lastSubmitted,
            lastDownloaded: m.lastDownloaded,
            isPending: m.isPending,
            isIndex: m.isSitemapsIndex,
            submitted: m.submitted,
            warnings: m.warnings,
            errors: m.errors,
            matchesRule: matchSeoIndexRule(m.path, rules),
          })),
        });
      } catch (err) {
        this.logger.warn(`Mapas del sitio de ${d.domain}: ${(err as Error).message}`);
        out.push({
          domainId: d.id,
          domain: d.domain,
          error: 'Google no ha devuelto los mapas del sitio. Inténtalo más tarde.',
          sitemaps: [],
        });
      }
    }
    return { fetchedAt: new Date().toISOString(), domains: out };
  }

  // -------------------------------------------------------------- guardar

  private async store(
    projectId: string,
    tenantId: string | null,
    cannibal: (SeoCannibalizationCandidate & {
      domainId: string;
      domain: string;
      from: string;
      to: string;
    })[],
    index: (SeoIndexFindingCandidate & { domainId: string; domain: string })[],
  ): Promise<SeoDiagnosticsRecalcDto> {
    const now = new Date();
    const cRecords = cannibal.map((c) => ({
      domain_id: c.domainId,
      domain: c.domain,
      key: sha1(`${c.domain}|${c.query}`),
      query: c.query,
      severity: c.severity,
      kind: c.kind,
      expected: c.expected,
      pages: c.pages,
      timeline: c.timeline,
      switches: c.switches,
      target_url: c.targetUrl,
      suggested_url: c.suggestedUrl,
      totals: c.totals,
      period_from: c.from,
      period_to: c.to,
      last_data_date: c.lastDataDate,
      reason: c.reason,
      action: c.action,
    }));
    // Una misma URL con dos categorías no puede pasar (una regla gana); la clave lo asegura igual.
    const iRecords = [
      ...new Map(
        index.map((f) => {
          const key = sha1(`${f.domain}|${f.url}|${f.category}`);
          return [
            key,
            {
              domain_id: f.domainId,
              domain: f.domain,
              key,
              url: f.url,
              category: f.category,
              rule: f.rule,
              clicks: f.clicks,
              impressions: f.impressions,
              first_date: f.firstDate,
              last_date: f.lastDate,
              reason: f.reason,
              action: f.action,
            },
          ];
        }),
      ).values(),
    ];
    // Una arreglada vuelve como nueva si Google la sigue enseñando pasado un margen
    // desde que se dio por arreglada (Google tarda semanas en retirar una página o
    // en asentar una redirección: sin margen, «arreglada» duraría tres días).
    const back = (table: string, dateCol: string) =>
      Prisma.raw(`${table}.status = 'fixed'
        AND EXCLUDED.${dateCol} > (${table}.resolved_at AT TIME ZONE 'Europe/Madrid')::date + ${FIXED_RETURN_MARGIN_DAYS}`);
    const result = await this.admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seo-diag:${projectId}`}::text))`;
        const cBack = back('seo_cannibalizations', 'last_data_date');
        const cUp =
          cRecords.length === 0
            ? []
            : await tx.$queryRaw<{ inserted: boolean; returned: boolean }[]>(Prisma.sql`
          INSERT INTO seo_cannibalizations (
            tenant_id, project_id, domain_id, domain, key, query, severity, kind, expected,
            pages, timeline, switches, target_url, suggested_url, totals, period_from, period_to,
            last_data_date, reason, action, active, detected_at, last_seen_at, created_at, updated_at
          )
          SELECT ${tenantId}::uuid, ${projectId}::uuid, x.domain_id::uuid, x.domain, x.key, x.query,
            x.severity, x.kind, x.expected, x.pages, x.timeline, x.switches, x.target_url,
            x.suggested_url, x.totals, x.period_from::date, x.period_to::date,
            x.last_data_date::date, x.reason, x.action, true, ${now}, ${now}, ${now}, ${now}
          FROM jsonb_to_recordset(${JSON.stringify(cRecords)}::jsonb) AS x(
            domain_id text, domain text, key text, query text, severity text, kind text,
            expected boolean, pages jsonb, timeline jsonb, switches int, target_url text,
            suggested_url text, totals jsonb, period_from text, period_to text,
            last_data_date text, reason text, action text
          )
          ON CONFLICT (project_id, key) DO UPDATE SET
            domain_id = EXCLUDED.domain_id,
            severity = EXCLUDED.severity,
            kind = EXCLUDED.kind,
            expected = EXCLUDED.expected,
            pages = EXCLUDED.pages,
            timeline = EXCLUDED.timeline,
            switches = EXCLUDED.switches,
            target_url = EXCLUDED.target_url,
            suggested_url = EXCLUDED.suggested_url,
            totals = EXCLUDED.totals,
            period_from = EXCLUDED.period_from,
            period_to = EXCLUDED.period_to,
            last_data_date = EXCLUDED.last_data_date,
            reason = EXCLUDED.reason,
            action = EXCLUDED.action,
            active = true,
            last_seen_at = EXCLUDED.last_seen_at,
            updated_at = EXCLUDED.updated_at,
            status = CASE WHEN ${cBack} THEN 'new' ELSE seo_cannibalizations.status END,
            returned_at = CASE WHEN ${cBack} THEN EXCLUDED.last_seen_at
              ELSE seo_cannibalizations.returned_at END,
            resolved_at = CASE WHEN ${cBack} THEN NULL ELSE seo_cannibalizations.resolved_at END
          RETURNING (xmax = 0) AS inserted, (returned_at = ${now}) AS returned`);
        const cGone = await tx.$executeRaw`
          UPDATE seo_cannibalizations SET active = false, updated_at = ${now}
          WHERE project_id = ${projectId}::uuid AND active AND last_seen_at < ${now}`;

        const iBack = back('seo_index_findings', 'last_date');
        const iUp =
          iRecords.length === 0
            ? []
            : await tx.$queryRaw<{ inserted: boolean; returned: boolean }[]>(Prisma.sql`
          INSERT INTO seo_index_findings (
            tenant_id, project_id, domain_id, domain, key, url, category, rule, clicks,
            impressions, first_date, last_date, reason, action, active, detected_at,
            last_seen_at, created_at, updated_at
          )
          SELECT ${tenantId}::uuid, ${projectId}::uuid, x.domain_id::uuid, x.domain, x.key, x.url,
            x.category, x.rule, x.clicks, x.impressions, x.first_date::date, x.last_date::date,
            x.reason, x.action, true, ${now}, ${now}, ${now}, ${now}
          FROM jsonb_to_recordset(${JSON.stringify(iRecords)}::jsonb) AS x(
            domain_id text, domain text, key text, url text, category text, rule text,
            clicks int, impressions int, first_date text, last_date text, reason text, action text
          )
          ON CONFLICT (project_id, key) DO UPDATE SET
            domain_id = EXCLUDED.domain_id,
            rule = EXCLUDED.rule,
            clicks = EXCLUDED.clicks,
            impressions = EXCLUDED.impressions,
            first_date = EXCLUDED.first_date,
            last_date = EXCLUDED.last_date,
            reason = EXCLUDED.reason,
            action = EXCLUDED.action,
            active = true,
            last_seen_at = EXCLUDED.last_seen_at,
            updated_at = EXCLUDED.updated_at,
            status = CASE WHEN ${iBack} THEN 'new' ELSE seo_index_findings.status END,
            returned_at = CASE WHEN ${iBack} THEN EXCLUDED.last_seen_at
              ELSE seo_index_findings.returned_at END,
            resolved_at = CASE WHEN ${iBack} THEN NULL ELSE seo_index_findings.resolved_at END
          RETURNING (xmax = 0) AS inserted, (returned_at = ${now}) AS returned`);
        // Los de la inspección de URL (PR 9) los mantiene la inspección, no este cálculo.
        const iGone = await tx.$executeRaw`
          UPDATE seo_index_findings SET active = false, updated_at = ${now}
          WHERE project_id = ${projectId}::uuid AND active AND last_seen_at < ${now}
            AND evidence = 'performance'`;
        await tx.seoProject.update({
          where: { id: projectId },
          data: { diagnosticsCalculatedAt: now },
        });
        const counts = (rows: { inserted: boolean; returned: boolean }[], gone: number) => ({
          created: rows.filter((r) => r.inserted).length,
          returned: rows.filter((r) => !r.inserted && r.returned).length,
          gone,
        });
        return { c: counts(cUp, cGone), i: counts(iUp, iGone) };
      },
      { timeout: 60_000 },
    );
    const cannibalization: Counts = { detected: cRecords.length, ...result.c };
    const indexCounts: Counts = { detected: iRecords.length, ...result.i };
    this.logger.log(
      `Diagnóstico de ${projectId}: ${cannibalization.detected} canibalizaciones, ${indexCounts.detected} páginas que no deberían estar`,
    );
    return { calculatedAt: now.toISOString(), cannibalization, index: indexCounts };
  }
}

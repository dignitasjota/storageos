import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_GSC_DELAY_DAYS,
  SEO_TABLE_CSV_MAX,
  daysBetween,
  seoChange,
  seoAreaLikePatterns,
  seoBrandLikePatterns,
  seoBrandTerms,
  seoComparison,
  seoMobileGap,
  seoPeriodCovered,
  seoPanelRange,
  seoRowVariation,
  seoTopN,
  seoTotalsFromSums,
  shiftDate,
  undetailedSearches,
  type SeoCrossDto,
  type SeoDashboardDayDto,
  type SeoBrandFilter,
  type SeoBrandSideDto,
  type SeoBrandSplitDto,
  type SeoDashboardDto,
  type SeoMetricSums,
  type SeoPageDeviceRowDto,
  type SeoPageDevicesDto,
  type SeoPanelPeriod,
  type SeoPanelRange,
  type SeoProjectOverviewDto,
  type SeoShareRow,
  type SeoTablePageDto,
  type SeoTableRowDto,
  type SeoTableSort,
} from '@storageos/shared';

import { CSV_BOM, csvCell } from '../../common/csv';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SeoProjectsService, type ProjectRow, type SeoOwner } from './seo-projects.service';

const today = () => new Date().toISOString().slice(0, 10);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Fila de sumas que devuelve la base de datos (todo en `float8`). */
interface SumsRow {
  c: number | null;
  i: number | null;
  w: number | null;
  ps: number | null;
  n: number | null;
}

const toSums = (r: SumsRow | undefined): SeoMetricSums => ({
  clicks: Number(r?.c ?? 0),
  impressions: Number(r?.i ?? 0),
  weightedPosition: Number(r?.w ?? 0),
  positionSum: Number(r?.ps ?? 0),
  rows: Number(r?.n ?? 0),
});

/** Columnas de suma (las mismas en todas las consultas). */
const SUMS = Prisma.sql`
  SUM(clicks)::float8 AS c,
  SUM(impressions)::float8 AS i,
  SUM(position * impressions)::float8 AS w,
  SUM(position)::float8 AS ps,
  COUNT(*)::float8 AS n`;

const DIM_COLUMN = { query: Prisma.raw('query'), page: Prisma.raw('page') } as const;

/** Orden de las tablas: expresión y sentido por defecto. */
const SORTS: Record<SeoTableSort, { expr: string; dir: 'ASC' | 'DESC' }> = {
  clicks: { expr: 'c', dir: 'DESC' },
  impressions: { expr: 'i', dir: 'DESC' },
  ctr: { expr: 'ctr', dir: 'DESC' },
  position: { expr: 'pos', dir: 'ASC' },
  change: { expr: 'chg', dir: 'DESC' },
};

export interface SeoPanelQuery {
  period: SeoPanelPeriod;
  from?: string | undefined;
  to?: string | undefined;
  domainId?: string | undefined;
  /** Mejora 3: solo búsquedas de marca o sin marca (con los términos del proyecto). */
  brand?: SeoBrandFilter | undefined;
  /** Mejora 5: solo búsquedas que nombran esta zona. */
  area?: string | undefined;
}

/** Minúsculas y sin tildes en SQL (para comparar con los términos de marca y zonas). */
export const PLAIN_SQL = (col: Prisma.Sql) =>
  Prisma.sql`translate(lower(${col}), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc')`;

/**
 * Condición sobre la columna `query` para la marca y la zona. Con la marca
 * pedida pero sin términos, no filtra (el panel invita a ponerlos).
 */
export function queryFilterSql(
  col: Prisma.Sql,
  brandTerms: readonly string[],
  brand: SeoBrandFilter | undefined,
  areaPatterns: readonly string[] | undefined,
): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (brand && brand !== 'all') {
    const patterns = seoBrandLikePatterns(brandTerms);
    if (patterns.length) {
      const any = Prisma.join(
        patterns.map((p) => Prisma.sql`${PLAIN_SQL(col)} LIKE ${p}`),
        ' OR ',
      );
      parts.push(brand === 'brand' ? Prisma.sql`AND (${any})` : Prisma.sql`AND NOT (${any})`);
    }
  }
  if (areaPatterns && areaPatterns.length) {
    const any = Prisma.join(
      areaPatterns.map((p) => Prisma.sql`${PLAIN_SQL(col)} LIKE ${p}`),
      ' OR ',
    );
    parts.push(Prisma.sql`AND (${any})`);
  }
  return parts.length ? Prisma.join(parts, ' ') : Prisma.empty;
}

export interface SeoTableQuery extends SeoPanelQuery {
  search?: string | undefined;
  sort: SeoTableSort;
  dir?: 'asc' | 'desc' | undefined;
  offset: number;
  limit: number;
}

/**
 * Panel de SEO Avanzado (§6, §8, §19.1). Cada parte lee de UN cruce de
 * `seo_gsc_metrics` y nunca suma dos: los totales y la evolución del cruce
 * `site`; dispositivos, países y tipos de búsqueda de los suyos; búsquedas y
 * páginas de `query` y `page`; el cruce búsqueda ↔ página de `query_page`.
 * Las sumas las hace la base de datos (no se traen las filas).
 */
@Injectable()
export class SeoPanelService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
  ) {}

  // ----------------------------------------------------------------- resumen

  async dashboard(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoPanelQuery,
  ): Promise<SeoDashboardDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const domain = this.pickDomain(project, q.domainId);
    const bounds = domain ? await this.bounds(domain.id) : { first: null, last: null };
    const range = this.range(q, bounds.last);
    // El retraso es el de la última descarga buena, no el del último día con filas:
    // un sitio sin impresiones no es un Google «sin datos».
    const delaySource = domain?.syncedUntil ?? domain?.dataUntil ?? null;
    const delay = delaySource ? daysBetween(dateOnly(delaySource)!, today()) : null;
    const syncedUntil = dateOnly(domain?.syncedUntil);
    const empty = { clicks: 0, impressions: 0, ctr: null, position: null };
    const base: SeoDashboardDto = {
      projectId,
      domainId: domain?.id ?? null,
      domain: domain?.domain ?? null,
      period: q.period,
      lastDate: bounds.last,
      firstDate: bounds.first,
      from: range.from,
      to: range.to,
      days: range.days,
      previousFrom: range.previousFrom,
      previousTo: range.previousTo,
      yearAgoFrom: range.yearAgoFrom,
      yearAgoTo: range.yearAgoTo,
      current: empty,
      previous: null,
      previousChange: null,
      yearAgo: null,
      yearAgoChange: null,
      daily: [],
      importedDays: 0,
      devices: [],
      countries: [],
      countriesRest: null,
      searchTypes: [],
      undetailed: null,
      otherDomains: [],
      dataDelayDays: delay,
      delayed: delay !== null && delay > SEO_GSC_DELAY_DAYS,
    };
    if (!domain || !bounds.last) return base;

    const id = domain.id;
    const others = project.domains.filter((d) => d.id !== id);
    const [
      cur,
      prev,
      yoy,
      prevRows,
      yoyRows,
      daily,
      prevDaily,
      devices,
      countries,
      types,
      byQuery,
      siteOnDetailedDays,
      otherRows,
    ] = await Promise.all([
      this.sums(id, 'site', range.from, range.to),
      this.sums(id, 'site', range.previousFrom, range.previousTo),
      this.sums(id, 'site', range.yearAgoFrom, range.yearAgoTo),
      this.count(id, range.previousFrom, range.previousTo),
      this.count(id, range.yearAgoFrom, range.yearAgoTo),
      this.siteDays(id, range.from, range.to),
      this.siteDays(id, range.previousFrom, range.previousTo),
      this.grouped(id, 'device', Prisma.raw('device'), range.from, range.to),
      this.grouped(id, 'country', Prisma.raw('country'), range.from, range.to),
      this.grouped(id, 'search_type', Prisma.raw('search_type'), range.from, range.to),
      this.sums(id, 'query', range.from, range.to),
      this.siteSumsOnDetailedDays(id, range.from, range.to),
      others.length > 0
        ? this.admin.$queryRaw<{ id: string; c: number; i: number }[]>(Prisma.sql`
              SELECT domain_id::text AS id, SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i
              FROM seo_gsc_metrics
              WHERE domain_id = ANY(${others.map((d) => d.id)}::uuid[]) AND grain = 'site'
                AND date BETWEEN ${range.from}::date AND ${range.to}::date
              GROUP BY domain_id`)
        : Promise.resolve([]),
    ]);

    const current = seoTotalsFromSums(cur);
    // Solo se compara si hay datos de casi todos los días de ese periodo (un hueco
    // entre lo importado y lo de la API daría una variación falsa).
    const covers = (from: string, to: string, rows: number) =>
      seoPeriodCovered({ firstDate: bounds.first, from, to, daysWithData: rows, syncedUntil });
    const previous = seoComparison(
      current,
      seoTotalsFromSums(prev),
      covers(range.previousFrom, range.previousTo, prevRows),
    );
    const yearAgo = seoComparison(
      current,
      seoTotalsFromSums(yoy),
      covers(range.yearAgoFrom, range.yearAgoTo, yoyRows),
    );

    // Un punto por día (los que Google no da, a cero), con el del periodo anterior.
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const prevByDate = new Map(prevDaily.map((d) => [d.date, d]));
    const points: SeoDashboardDayDto[] = [];
    for (let d = range.from, k = 0; d <= range.to; d = shiftDate(d, 1), k++) {
      const row = byDate.get(d);
      const p = prevByDate.get(shiftDate(range.previousFrom, k));
      points.push({
        date: d,
        clicks: row?.clicks ?? 0,
        impressions: row?.impressions ?? 0,
        ctr:
          row && row.impressions > 0
            ? Math.round((row.clicks / row.impressions) * 1000) / 1000
            : null,
        // Un día sin impresiones no tiene posición (un 0 sería «el mejor puesto»).
        position: row && row.impressions > 0 ? Math.round(row.position * 10) / 10 : null,
        source: row?.source === 'import' ? 'import' : 'api',
        // Un día sin datos del periodo anterior queda en blanco (no a cero).
        previousClicks: previous.totals && p ? p.clicks : null,
        previousImpressions: previous.totals && p ? p.impressions : null,
      });
    }

    const share = (rows: { key: string; sums: SeoMetricSums }[]): SeoShareRow[] =>
      rows
        .map((r) => {
          const totals = seoTotalsFromSums(r.sums);
          return {
            key: r.key,
            totals,
            clickShare:
              current.clicks > 0
                ? Math.round((totals.clicks / current.clicks) * 1000) / 1000
                : null,
          };
        })
        .sort(
          (a, b) =>
            b.totals.clicks - a.totals.clicks || b.totals.impressions - a.totals.impressions,
        );
    const countryTop = seoTopN(
      countries.map((r) => {
        const t = seoTotalsFromSums(r.sums);
        return {
          key: r.key,
          clicks: t.clicks,
          impressions: t.impressions,
          position: t.position ?? 0,
        };
      }),
      10,
      current.clicks,
    );

    return {
      ...base,
      current,
      previous: previous.totals,
      previousChange: previous.change,
      yearAgo: yearAgo.totals,
      yearAgoChange: yearAgo.change,
      daily: points,
      importedDays: daily.filter((d) => d.source === 'import').length,
      devices: share(devices),
      countries: countryTop.top,
      countriesRest: countryTop.rest,
      searchTypes: share(types).filter((t) => t.totals.impressions > 0),
      // Solo se resta en los días que tienen detalle por búsqueda: los importados
      // de un Excel (solo el total del día) o los que aún se están descargando
      // no son «búsquedas que Google no detalla».
      undetailed:
        byQuery.rows > 0
          ? undetailedSearches(seoTotalsFromSums(siteOnDetailedDays), seoTotalsFromSums(byQuery))
          : null,
      otherDomains: others.map((d) => {
        const r = otherRows.find((o) => o.id === d.id);
        return {
          domainId: d.id,
          domain: d.domain,
          role: d.role,
          clicks: Number(r?.c ?? 0),
          impressions: Number(r?.i ?? 0),
        };
      }),
    };
  }

  // ------------------------------------------------------ búsquedas y páginas

  async table(
    owner: SeoOwner | undefined,
    projectId: string,
    dimension: 'query' | 'page',
    q: SeoTableQuery,
  ): Promise<SeoTablePageDto> {
    const ctx = await this.tableContext(owner, projectId, q);
    const limit = Math.min(Math.max(1, q.limit), SEO_TABLE_CSV_MAX);
    const offset = Math.max(0, q.offset);
    if (!ctx) {
      return this.emptyTable(dimension, q, offset, limit);
    }
    const rows = await this.tableRows(ctx, dimension, q, offset, limit);
    const total = rows[0]?.total ?? 0;
    return {
      dimension,
      from: ctx.range.from,
      to: ctx.range.to,
      previousFrom: ctx.range.previousFrom,
      previousTo: ctx.range.previousTo,
      previousAvailable: ctx.previousAvailable,
      total,
      offset,
      limit,
      hasMore: offset + rows.length < total,
      items: rows.map((r) => r.dto),
    };
  }

  /** CSV de búsquedas o páginas (hasta `SEO_TABLE_CSV_MAX` filas, en el orden pedido). */
  async tableCsv(
    owner: SeoOwner | undefined,
    projectId: string,
    dimension: 'query' | 'page',
    q: SeoTableQuery,
  ): Promise<string> {
    const page = await this.table(owner, projectId, dimension, {
      ...q,
      offset: 0,
      limit: SEO_TABLE_CSV_MAX,
    });
    const header = [
      dimension === 'query' ? 'Búsqueda' : 'Página',
      'Clics',
      'Impresiones',
      'CTR (%)',
      'Posición media',
      'Clics periodo anterior',
      'Variación de clics',
      'Posición periodo anterior',
      'Puestos que sube',
    ];
    const lines = [header.map(csvCell).join(';')];
    for (const r of page.items) {
      lines.push(
        [
          r.key,
          r.clicks,
          r.impressions,
          r.ctr === null ? null : Math.round(r.ctr * 1000) / 10,
          r.position,
          r.previousClicks,
          r.clicksChange,
          r.previousPosition,
          r.positionDiff,
        ]
          .map(csvCell)
          .join(';'),
      );
    }
    return CSV_BOM + lines.join('\r\n');
  }

  /** Una búsqueda → sus páginas, o una página → sus búsquedas (cruce `query_page`). */
  async cross(
    owner: SeoOwner | undefined,
    projectId: string,
    dimension: 'query' | 'page',
    value: string,
    q: SeoPanelQuery,
  ): Promise<SeoCrossDto> {
    const ctx = await this.tableContext(owner, projectId, q);
    if (!ctx) return { dimension, value, from: '', to: '', rows: [] };
    const where = DIM_COLUMN[dimension];
    const other = DIM_COLUMN[dimension === 'query' ? 'page' : 'query'];
    const rows = await this.admin.$queryRaw<(SumsRow & { key: string })[]>(Prisma.sql`
      SELECT ${other} AS key, ${SUMS}
      FROM seo_gsc_metrics
      WHERE domain_id = ${ctx.domainId}::uuid AND grain = 'query_page'
        AND date BETWEEN ${ctx.range.from}::date AND ${ctx.range.to}::date
        AND ${where} = ${value}
        ${dimension === 'page' ? queryFilterSql(Prisma.raw('query'), ctx.brandTerms, ctx.brand, ctx.areaPatterns) : Prisma.empty}
      GROUP BY ${other}
      ORDER BY c DESC, i DESC, key ASC
      LIMIT 100`);
    return {
      dimension,
      value,
      from: ctx.range.from,
      to: ctx.range.to,
      rows: rows.map((r) => ({ key: r.key, ...seoTotalsFromSums(toSums(r)) })),
    };
  }

  // ------------------------------------------ páginas: móvil frente a ordenador

  /**
   * Cada página con su CTR y su posición en móvil y en ordenador (cruce
   * `page_device`), marcando las que en móvil van claramente peor (mejora 11).
   */
  async pageDevices(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoPanelQuery & { onlyWorse?: boolean | undefined; limit?: number | undefined },
  ): Promise<SeoPageDevicesDto> {
    const ctx = await this.tableContext(owner, projectId, q);
    if (!ctx) {
      const range = this.range(q, null);
      return {
        projectId,
        from: range.from,
        to: range.to,
        total: 0,
        items: [],
        hasData: false,
      };
    }
    const rows = await this.admin.$queryRaw<
      {
        page: string;
        mc: number | null;
        mi: number | null;
        mw: number | null;
        dc: number | null;
        di: number | null;
        dw: number | null;
      }[]
    >(Prisma.sql`
      SELECT page,
        SUM(clicks) FILTER (WHERE upper(device) = 'MOBILE')::float8 AS mc,
        SUM(impressions) FILTER (WHERE upper(device) = 'MOBILE')::float8 AS mi,
        SUM(position * impressions) FILTER (WHERE upper(device) = 'MOBILE')::float8 AS mw,
        SUM(clicks) FILTER (WHERE upper(device) = 'DESKTOP')::float8 AS dc,
        SUM(impressions) FILTER (WHERE upper(device) = 'DESKTOP')::float8 AS di,
        SUM(position * impressions) FILTER (WHERE upper(device) = 'DESKTOP')::float8 AS dw
      FROM seo_gsc_metrics
      WHERE domain_id = ${ctx.domainId}::uuid AND grain = 'page_device' AND page <> ''
        AND date BETWEEN ${ctx.range.from}::date AND ${ctx.range.to}::date
      GROUP BY page
      ORDER BY COALESCE(SUM(impressions), 0) DESC
      LIMIT 1000`);
    const totals = (c: number | null, i: number | null, w: number | null) => ({
      clicks: Number(c ?? 0),
      impressions: Number(i ?? 0),
      position: Number(i ?? 0) > 0 ? Math.round((Number(w ?? 0) / Number(i)) * 10) / 10 : null,
    });
    const all: SeoPageDeviceRowDto[] = rows.map((r) => {
      const mobile = totals(r.mc, r.mi, r.mw);
      const desktop = totals(r.dc, r.di, r.dw);
      const gap = seoMobileGap(mobile, desktop);
      return {
        page: r.page,
        mobile: { ...mobile, ctr: gap.ctrMobile },
        desktop: { ...desktop, ctr: gap.ctrDesktop },
        worseOnMobile: gap.worse,
        reason: gap.reason,
        positionGap: gap.positionGap,
      };
    });
    const filtered = q.onlyWorse ? all.filter((r) => r.worseOnMobile) : all;
    filtered.sort(
      (a, b) =>
        Number(b.worseOnMobile) - Number(a.worseOnMobile) ||
        b.mobile.impressions - a.mobile.impressions,
    );
    return {
      projectId,
      from: ctx.range.from,
      to: ctx.range.to,
      total: filtered.length,
      items: filtered.slice(0, Math.min(Math.max(q.limit ?? 50, 1), 200)),
      hasData: rows.length > 0,
    };
  }

  // ------------------------------------------------ marca frente a no marca

  /**
   * Dos indicadores: lo que viene de búsquedas de marca y lo que no, con el
   * periodo anterior (mejora 3). Se lee del cruce `query`: las búsquedas que
   * Google no detalla (anónimas) quedan fuera de los dos.
   */
  async brandSplit(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoPanelQuery,
  ): Promise<SeoBrandSplitDto> {
    const ctx = await this.tableContext(owner, projectId, { ...q, brand: undefined });
    const empty: SeoBrandSideDto = {
      clicks: 0,
      impressions: 0,
      ctr: null,
      position: null,
      previousClicks: null,
      previousImpressions: null,
      previousPosition: null,
      clickShare: null,
    };
    if (!ctx) {
      const range = this.range(q, null);
      return {
        projectId,
        domainId: null,
        from: range.from,
        to: range.to,
        previousFrom: range.previousFrom,
        previousTo: range.previousTo,
        previousAvailable: false,
        needsTerms: true,
        terms: [],
        brand: empty,
        nonBrand: empty,
      };
    }
    const terms = seoBrandTerms(ctx.brandTerms);
    const side = async (mode: SeoBrandFilter): Promise<SumsRow | undefined> => {
      const cond = queryFilterSql(Prisma.raw('query'), terms, mode, ctx.areaPatterns);
      const run = async (from: string, to: string) => {
        const [r] = await this.admin.$queryRaw<SumsRow[]>(Prisma.sql`
          SELECT ${SUMS} FROM seo_gsc_metrics
          WHERE domain_id = ${ctx.domainId}::uuid AND grain = 'query'
            AND date BETWEEN ${from}::date AND ${to}::date ${cond}`);
        return r;
      };
      return run(ctx.range.from, ctx.range.to);
    };
    const previous = async (mode: SeoBrandFilter): Promise<SumsRow | undefined> => {
      const cond = queryFilterSql(Prisma.raw('query'), terms, mode, ctx.areaPatterns);
      const [r] = await this.admin.$queryRaw<SumsRow[]>(Prisma.sql`
        SELECT ${SUMS} FROM seo_gsc_metrics
        WHERE domain_id = ${ctx.domainId}::uuid AND grain = 'query'
          AND date BETWEEN ${ctx.range.previousFrom}::date AND ${ctx.range.previousTo}::date ${cond}`);
      return r;
    };
    const needsTerms = terms.length === 0;
    const [b, n, pb, pn] = needsTerms
      ? [undefined, undefined, undefined, undefined]
      : await Promise.all([
          side('brand'),
          side('nonbrand'),
          ctx.previousAvailable ? previous('brand') : Promise.resolve(undefined),
          ctx.previousAvailable ? previous('nonbrand') : Promise.resolve(undefined),
        ]);
    const total = Number(b?.c ?? 0) + Number(n?.c ?? 0);
    const dto = (cur: SumsRow | undefined, prev: SumsRow | undefined): SeoBrandSideDto => {
      const c = seoTotalsFromSums(toSums(cur));
      const p = prev ? seoTotalsFromSums(toSums(prev)) : null;
      return {
        clicks: c.clicks,
        impressions: c.impressions,
        ctr: c.ctr,
        position: c.position,
        previousClicks: p ? p.clicks : null,
        previousImpressions: p ? p.impressions : null,
        previousPosition: p ? p.position : null,
        clickShare: total > 0 ? c.clicks / total : null,
      };
    };
    return {
      projectId,
      domainId: ctx.domainId,
      from: ctx.range.from,
      to: ctx.range.to,
      previousFrom: ctx.range.previousFrom,
      previousTo: ctx.range.previousTo,
      previousAvailable: ctx.previousAvailable && !needsTerms,
      needsTerms,
      terms,
      brand: dto(b, pb),
      nonBrand: dto(n, pn),
    };
  }

  // --------------------------------------------------------- vista global

  /** Cada proyecto (plataforma y tenants) con sus 28 días frente a los 28 anteriores. */
  async overview(): Promise<SeoProjectOverviewDto[]> {
    const projects = await this.admin.seoProject.findMany({
      include: { domains: { orderBy: { createdAt: 'asc' } } },
      orderBy: [{ tenantId: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take: 1000,
    });
    const primary = new Map(
      projects.map((p) => [p.id, p.domains.find((d) => d.role === 'primary') ?? p.domains[0]]),
    );
    const ids = [...primary.values()].flatMap((d) => (d ? [d.id] : []));
    const rows = ids.length
      ? await this.admin.$queryRaw<
          {
            id: string;
            last: string;
            first: string;
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
          }[]
        >(Prisma.sql`
          WITH b AS (
            SELECT domain_id, MIN(date) AS f, MAX(date) AS d
            FROM seo_gsc_metrics
            WHERE grain = 'site' AND domain_id = ANY(${ids}::uuid[])
            GROUP BY domain_id
          )
          SELECT m.domain_id::text AS id, b.d::text AS last, b.f::text AS first,
            SUM(m.clicks) FILTER (WHERE m.date > b.d - 28)::float8 AS c,
            SUM(m.impressions) FILTER (WHERE m.date > b.d - 28)::float8 AS i,
            SUM(m.position * m.impressions) FILTER (WHERE m.date > b.d - 28)::float8 AS w,
            SUM(m.position) FILTER (WHERE m.date > b.d - 28)::float8 AS ps,
            COUNT(*) FILTER (WHERE m.date > b.d - 28)::float8 AS n,
            SUM(m.clicks) FILTER (WHERE m.date <= b.d - 28)::float8 AS pc,
            SUM(m.impressions) FILTER (WHERE m.date <= b.d - 28)::float8 AS pi,
            SUM(m.position * m.impressions) FILTER (WHERE m.date <= b.d - 28)::float8 AS pw,
            SUM(m.position) FILTER (WHERE m.date <= b.d - 28)::float8 AS pps,
            COUNT(*) FILTER (WHERE m.date <= b.d - 28)::float8 AS pn
          FROM seo_gsc_metrics m JOIN b ON b.domain_id = m.domain_id
          WHERE m.grain = 'site' AND m.date > b.d - 56
          GROUP BY m.domain_id, b.d, b.f`)
      : [];
    const byDomain = new Map(rows.map((r) => [r.id, r]));
    const tenantIds = [...new Set(projects.flatMap((p) => (p.tenantId ? [p.tenantId] : [])))];
    const tenants = tenantIds.length
      ? await this.admin.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, name: true },
        })
      : [];
    const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
    return projects.map((p) => {
      const d = primary.get(p.id);
      const r = d ? byDomain.get(d.id) : undefined;
      const current = seoTotalsFromSums(toSums(r));
      const prevSums = toSums(r ? { c: r.pc, i: r.pi, w: r.pw, ps: r.pps, n: r.pn } : undefined);
      const hasPrevious = !!r && r.first <= shiftDate(r.last, -55) && prevSums.rows > 0;
      const previous = hasPrevious ? seoTotalsFromSums(prevSums) : null;
      const delaySource = d?.syncedUntil ?? d?.dataUntil ?? null;
      const delay = delaySource ? daysBetween(dateOnly(delaySource)!, today()) : null;
      return {
        projectId: p.id,
        name: p.name,
        tenantId: p.tenantId,
        tenantName: p.tenantId ? (tenantName.get(p.tenantId) ?? null) : null,
        domain: d?.domain ?? null,
        lastDate: r?.last ?? null,
        current,
        previous,
        change: previous ? seoChange(current, previous) : null,
        delayed: delay !== null && delay > SEO_GSC_DELAY_DAYS,
      };
    });
  }

  // ------------------------------------------------------------- auxiliares

  private pickDomain(project: ProjectRow, domainId: string | undefined) {
    if (domainId) {
      const d = project.domains.find((x) => x.id === domainId);
      if (!d) throw new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
      return d;
    }
    return project.domains.find((d) => d.role === 'primary') ?? project.domains[0] ?? null;
  }

  private range(q: SeoPanelQuery, lastDate: string | null) {
    const range = seoPanelRange({
      period: q.period,
      lastDate: lastDate ?? today(),
      from: q.from ?? null,
      to: q.to ?? null,
    });
    if (!range) {
      throw new BadRequestException({
        code: 'seo_invalid_range',
        message: 'Elige las dos fechas del periodo.',
      });
    }
    return range;
  }

  private async bounds(domainId: string): Promise<{ first: string | null; last: string | null }> {
    const b = await this.admin.seoGscMetric.aggregate({
      where: { domainId, grain: 'site' },
      _min: { date: true },
      _max: { date: true },
    });
    return { first: dateOnly(b._min.date), last: dateOnly(b._max.date) };
  }

  private async sums(domainId: string, grain: string, from: string, to: string) {
    const [r] = await this.admin.$queryRaw<SumsRow[]>(Prisma.sql`
      SELECT ${SUMS} FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = ${grain}
        AND date BETWEEN ${from}::date AND ${to}::date`);
    return toSums(r);
  }

  /** El total del sitio, sumado solo en los días que tienen filas de búsquedas. */
  private async siteSumsOnDetailedDays(domainId: string, from: string, to: string) {
    const [r] = await this.admin.$queryRaw<SumsRow[]>(Prisma.sql`
      SELECT ${SUMS} FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = 'site'
        AND date BETWEEN ${from}::date AND ${to}::date
        AND date IN (
          SELECT DISTINCT date FROM seo_gsc_metrics
          WHERE domain_id = ${domainId}::uuid AND grain = 'query'
            AND date BETWEEN ${from}::date AND ${to}::date)`);
    return toSums(r);
  }

  /** Días del periodo con filas de búsquedas. */
  private async detailDays(domainId: string, from: string, to: string): Promise<number> {
    const [r] = await this.admin.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT date)::int AS n FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = 'query'
        AND date BETWEEN ${from}::date AND ${to}::date`);
    return Number(r?.n ?? 0);
  }

  private async count(domainId: string, from: string, to: string): Promise<number> {
    return this.admin.seoGscMetric.count({
      where: {
        domainId,
        grain: 'site',
        date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
      },
    });
  }

  private async siteDays(domainId: string, from: string, to: string) {
    const rows = await this.admin.seoGscMetric.findMany({
      where: {
        domainId,
        grain: 'site',
        date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
      },
      select: { date: true, clicks: true, impressions: true, position: true, source: true },
      orderBy: { date: 'asc' },
    });
    return rows.map((r) => ({
      date: dateOnly(r.date)!,
      clicks: r.clicks,
      impressions: r.impressions,
      position: Number(r.position),
      source: r.source,
    }));
  }

  private async grouped(
    domainId: string,
    grain: string,
    column: Prisma.Sql,
    from: string,
    to: string,
  ): Promise<{ key: string; sums: SeoMetricSums }[]> {
    const rows = await this.admin.$queryRaw<(SumsRow & { key: string })[]>(Prisma.sql`
      SELECT ${column} AS key, ${SUMS} FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = ${grain}
        AND date BETWEEN ${from}::date AND ${to}::date
      GROUP BY ${column}`);
    return rows.map((r) => ({ key: r.key, sums: toSums(r) }));
  }

  private async tableContext(owner: SeoOwner | undefined, projectId: string, q: SeoPanelQuery) {
    const project = await this.projects.resolveProject(owner, projectId);
    const domain = this.pickDomain(project, q.domainId);
    if (!domain) return null;
    const bounds = await this.bounds(domain.id);
    if (!bounds.last) return null;
    const range = this.range(q, bounds.last);
    // Las tablas comparan los cruces `query` y `page`, que solo existen desde que
    // la API los descarga: los días importados de un Excel solo tienen el total.
    // El periodo anterior solo vale si empieza donde ya hay detalle.
    const detailSince = dateOnly(domain.detailSince);
    let previousAvailable: boolean;
    if (detailSince) {
      previousAvailable = seoPeriodCovered({
        firstDate: detailSince,
        from: range.previousFrom,
        to: range.previousTo,
        daysWithData: 0,
        syncedUntil: dateOnly(domain.syncedUntil),
      });
    } else {
      const detailDays = await this.detailDays(domain.id, range.previousFrom, range.previousTo);
      previousAvailable = seoPeriodCovered({
        firstDate: bounds.first,
        from: range.previousFrom,
        to: range.previousTo,
        daysWithData: detailDays,
      });
    }
    return {
      domainId: domain.id,
      range,
      previousAvailable,
      brandTerms: project.brandTerms,
      brand: q.brand,
      areaPatterns: q.area ? seoAreaLikePatterns(q.area) : undefined,
    };
  }

  private emptyTable(
    dimension: 'query' | 'page',
    q: SeoPanelQuery,
    offset: number,
    limit: number,
  ): SeoTablePageDto {
    const range = this.range(q, null);
    return {
      dimension,
      from: range.from,
      to: range.to,
      previousFrom: range.previousFrom,
      previousTo: range.previousTo,
      previousAvailable: false,
      total: 0,
      offset,
      limit,
      hasMore: false,
      items: [],
    };
  }

  private async tableRows(
    ctx: {
      domainId: string;
      range: SeoPanelRange;
      previousAvailable: boolean;
      brandTerms: string[];
      brand: SeoBrandFilter | undefined;
      areaPatterns: string[] | undefined;
    },
    dimension: 'query' | 'page',
    q: SeoTableQuery,
    offset: number,
    limit: number,
  ): Promise<{ total: number; dto: SeoTableRowDto }[]> {
    const col = DIM_COLUMN[dimension];
    const search = q.search?.trim().slice(0, 200);
    const filter = search
      ? Prisma.sql`AND ${col} ILIKE ${`%${search.replace(/[\\%_]/g, '\\$&')}%`}`
      : Prisma.empty;
    // Marca y zona se leen de la búsqueda: para las páginas, del cruce búsqueda ↔ página.
    const queryFilter = queryFilterSql(
      Prisma.raw('query'),
      ctx.brandTerms,
      ctx.brand,
      ctx.areaPatterns,
    );
    const filtered = queryFilter !== Prisma.empty;
    const grain = dimension === 'page' && filtered ? 'query_page' : dimension;
    const sort = SORTS[q.sort];
    const dir = q.dir ? (q.dir === 'asc' ? 'ASC' : 'DESC') : sort.dir;
    const order = Prisma.raw(`${sort.expr} ${dir} NULLS LAST, c DESC, i DESC, key ASC`);
    const chg = ctx.previousAvailable
      ? Prisma.sql`cur.c - COALESCE(prev.c, 0)`
      : Prisma.sql`NULL::float8`;
    const prevCte = ctx.previousAvailable
      ? Prisma.sql`
          SELECT ${col} AS key, ${SUMS}
          FROM seo_gsc_metrics
          WHERE domain_id = ${ctx.domainId}::uuid AND grain = ${grain}
            AND date BETWEEN ${ctx.range.previousFrom}::date AND ${ctx.range.previousTo}::date
            ${queryFilter}
            AND ${col} IN (SELECT key FROM cur)
          GROUP BY ${col}`
      : Prisma.sql`SELECT NULL::text AS key, NULL::float8 AS c, NULL::float8 AS i,
          NULL::float8 AS w, NULL::float8 AS ps, NULL::float8 AS n WHERE false`;
    const rows = await this.admin.$queryRaw<
      (SumsRow & {
        key: string;
        pc: number | null;
        pi: number | null;
        pw: number | null;
        pps: number | null;
        pn: number | null;
        total: number;
      })[]
    >(Prisma.sql`
      WITH cur AS (
        SELECT ${col} AS key, ${SUMS}
        FROM seo_gsc_metrics
        WHERE domain_id = ${ctx.domainId}::uuid AND grain = ${grain}
          AND date BETWEEN ${ctx.range.from}::date AND ${ctx.range.to}::date
          ${queryFilter}
          ${filter}
        GROUP BY ${col}
      ), prev AS (${prevCte}), joined AS (
        SELECT cur.key, cur.c, cur.i, cur.w, cur.ps, cur.n,
          prev.c AS pc, prev.i AS pi, prev.w AS pw, prev.ps AS pps, prev.n AS pn,
          CASE WHEN cur.i > 0 THEN cur.c / cur.i END AS ctr,
          CASE WHEN cur.i > 0 THEN cur.w / cur.i ELSE cur.ps / NULLIF(cur.n, 0) END AS pos,
          ${chg} AS chg
        FROM cur LEFT JOIN prev ON prev.key = cur.key
      )
      SELECT *, (COUNT(*) OVER ())::int AS total FROM joined
      ORDER BY ${order}
      LIMIT ${limit} OFFSET ${offset}`);
    return rows.map((r) => {
      const current = seoTotalsFromSums(toSums(r));
      const prev = ctx.previousAvailable
        ? seoTotalsFromSums(toSums({ c: r.pc, i: r.pi, w: r.pw, ps: r.pps, n: r.pn }))
        : null;
      const variation = seoRowVariation(current, prev);
      return {
        total: Number(r.total),
        dto: {
          key: r.key,
          clicks: current.clicks,
          impressions: current.impressions,
          ctr: current.ctr,
          position: current.position,
          previousClicks: prev ? prev.clicks : null,
          previousImpressions: prev ? prev.impressions : null,
          previousPosition: prev ? prev.position : null,
          ...variation,
        },
      };
    });
  }
}

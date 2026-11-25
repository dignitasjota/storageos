import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_SITE_CHANGE_CSV_MAX,
  SEO_SITE_CHANGE_PAGE_SIZE,
  SEO_SITE_CHANGE_TYPES,
  SEO_SITE_CHANGE_TYPE_LABELS,
  SEO_SITE_CHANGE_VERDICT_LABELS,
  SEO_SITE_CHANGE_WINDOWS,
  normalizeSeoKeyword,
  seoOverlappingChanges,
  seoChange,
  seoPageMatchesKey,
  seoSiteChangeRange,
  seoSiteChangeScope,
  seoSiteChangeVerdict,
  seoSiteChangeWindowState,
  seoTotalsFromSums,
  seoUrlKey,
  shiftDate,
  type CreateSeoSiteChangeInput,
  type SeoChartMarkerDto,
  type SeoDashboardDayDto,
  type SeoMetricSums,
  type SeoSiteChangeDetailDto,
  type SeoSiteChangeDto,
  type SeoSiteChangeItemDto,
  type SeoSiteChangeListDto,
  type SeoSiteChangeOverlapInput,
  type SeoSiteChangeType,
  type SeoSiteChangeWindowDto,
  type SeoTotalsDto,
  type UpdateSeoSiteChangeInput,
} from '@storageos/shared';

import { CSV_BOM, csvCell, csvLineCell } from '../../../common/csv';
import { todayInTimezone, zonedDayStart } from '../../../common/format';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoProjectsService, type ProjectRow, type SeoOwner } from '../seo-projects.service';

import { assertPlanLinks, loadPlanSource, personNames, resolveDomainId } from './seo-plan-links';

import type { SeoActor } from '../seo-projects.service';

type Row = Prisma.SeoSiteChangeGetPayload<object>;
type Sums = Map<string, SeoMetricSums>;

const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const today = () => todayInTimezone().toISOString().slice(0, 10);
const MAX_WINDOW = Math.max(...SEO_SITE_CHANGE_WINDOWS);
const EMPTY: SeoMetricSums = {
  clicks: 0,
  impressions: 0,
  weightedPosition: 0,
  positionSum: 0,
  rows: 0,
};

export interface SeoSiteChangeQuery {
  domainId?: string | undefined;
  type?: SeoSiteChangeType | undefined;
  search?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export function parseSeoSiteChangeQuery(q: Record<string, string | undefined>): SeoSiteChangeQuery {
  const num = (v: string | undefined) => (v !== undefined && v !== '' ? Number(v) : undefined);
  return {
    domainId: q.domainId || undefined,
    type: (SEO_SITE_CHANGE_TYPES as readonly string[]).includes(q.type ?? '')
      ? (q.type as SeoSiteChangeType)
      : undefined,
    search: q.search?.trim().slice(0, 200) || undefined,
    offset: num(q.offset),
    limit: num(q.limit),
  };
}

/** Suma de las filas de un día y otro (las de varias páginas o búsquedas). */
function addSums(a: SeoMetricSums | undefined, b: SeoMetricSums): SeoMetricSums {
  if (!a) return { ...b };
  return {
    clicks: a.clicks + b.clicks,
    impressions: a.impressions + b.impressions,
    weightedPosition: a.weightedPosition + b.weightedPosition,
    positionSum: a.positionSum + b.positionSum,
    rows: a.rows + b.rows,
  };
}

function sumRange(byDate: Sums, from: string, to: string): SeoTotalsDto {
  let acc: SeoMetricSums = { ...EMPTY };
  for (const [date, s] of byDate) if (date >= from && date <= to) acc = addSums(acc, s);
  return seoTotalsFromSums(acc);
}

/** Una fila de las sumas de SQL (por clave y día). */
interface SqlSumRow {
  k: string;
  date: Date;
  c: number;
  i: number;
  w: number;
  ps: number;
  n: number;
}

const toSums = (r: SqlSumRow): SeoMetricSums => ({
  clicks: Number(r.c),
  impressions: Number(r.i),
  weightedPosition: Number(r.w),
  positionSum: Number(r.ps),
  rows: Number(r.n),
});

/** Lo que dio Google del alcance de una actuación, día a día. */
interface ScopeData {
  /** El alcance entero (URLs si las hay; si no, palabras; si no, el sitio). */
  total: Sums;
  byUrl: Map<string, Sums>;
  byKeyword: Map<string, Sums>;
  /** El cruce `site` del dominio. */
  site: Sums;
}

/**
 * Actuaciones SEO (§18.8 y §19.6): alta, lista con su antes y después a 7, 28
 * y 90 días, ficha con el detalle por URL y por palabra y el gráfico, marcas
 * para los gráficos del panel y CSV. La comparación se calcula al leer, desde
 * `seo_gsc_metrics`, y solo cuando la ventana posterior ha terminado y Google
 * ha dado sus datos. Con dueño (`tenantId` o `null` = la plataforma), solo las
 * suyas; sin dueño (`undefined`), el super admin leyendo cualquier proyecto.
 */
@Injectable()
export class SeoSiteChangesService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
  ) {}

  private notFound() {
    return new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
  }

  private async findRow(projectId: string, id: string): Promise<Row> {
    const row = await this.admin.seoSiteChange.findFirst({ where: { id, projectId } });
    if (!row) throw this.notFound();
    return row;
  }

  // ------------------------------------------------------------- lectura

  private where(projectId: string, q: SeoSiteChangeQuery): Prisma.SeoSiteChangeWhereInput {
    return {
      projectId,
      ...(q.domainId ? { domainId: q.domainId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.search
        ? {
            OR: [
              { title: { contains: q.search, mode: 'insensitive' } },
              { description: { contains: q.search, mode: 'insensitive' } },
              { keywords: { has: normalizeSeoKeyword(q.search) } },
            ],
          }
        : {}),
    };
  }

  async list(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoSiteChangeQuery,
  ): Promise<SeoSiteChangeListDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const limit = Math.min(Math.max(1, q.limit ?? SEO_SITE_CHANGE_PAGE_SIZE), 200);
    const offset = Math.max(0, q.offset ?? 0);
    const where = this.where(projectId, q);
    const [total, rows] = await Promise.all([
      this.admin.seoSiteChange.count({ where }),
      this.admin.seoSiteChange.findMany({
        where,
        orderBy: [{ changeDate: 'desc' }, { changedAt: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: limit,
      }),
    ]);
    return {
      total,
      offset,
      limit,
      hasMore: offset + rows.length < total,
      items: await this.toDtos(project, rows, false),
    };
  }

  async detail(
    owner: SeoOwner | undefined,
    projectId: string,
    id: string,
  ): Promise<SeoSiteChangeDetailDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const row = await this.findRow(projectId, id);
    const [dto] = await this.toDtos(project, [row], true);
    const domainId = resolveDomainId(project, row.domainId);
    const date = dateOnly(row.changeDate)!;
    let daily: SeoDashboardDayDto[] = [];
    if (domainId) {
      const bounds = await this.bounds(domainId);
      if (bounds.last) {
        const from = shiftDate(date, -MAX_WINDOW);
        const to = [shiftDate(date, MAX_WINDOW), bounds.last].sort()[0]!;
        if (from <= to) {
          const data = await this.scopeData(domainId, row, from, to);
          for (let d = from; d <= to; d = shiftDate(d, 1)) {
            const t = seoTotalsFromSums(data.total.get(d) ?? EMPTY);
            daily.push({
              date: d,
              clicks: t.clicks,
              impressions: t.impressions,
              ctr: t.ctr,
              position: t.position,
              source: 'api',
              previousClicks: null,
              previousImpressions: null,
            });
          }
          if (daily.every((x) => x.impressions === 0)) daily = [];
        }
      }
    }
    const overlaps = new Map<string, SeoChartMarkerDto>();
    for (const w of dto!.windows)
      for (const o of w.overlaps) overlaps.set(o.id, { id: o.id, date: o.date, title: o.title });
    return {
      ...dto!,
      daily,
      markers: [{ id: row.id, date, title: row.title }, ...overlaps.values()].sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
      ),
    };
  }

  /**
   * Marcas para los gráficos del panel y de la ficha de una palabra: las
   * actuaciones del dominio entre dos fechas; con `query` o `url`, solo las que
   * la tocan (y las de todo el sitio).
   */
  async markers(
    owner: SeoOwner | undefined,
    projectId: string,
    q: { domainId?: string; from?: string; to?: string; query?: string; url?: string },
  ): Promise<SeoChartMarkerDto[]> {
    const project = await this.projects.resolveProject(owner, projectId);
    const domainId = q.domainId ? resolveDomainId(project, q.domainId) : null;
    const primary = resolveDomainId(project, null);
    const rows = await this.admin.seoSiteChange.findMany({
      where: {
        projectId,
        ...(q.from || q.to
          ? {
              changeDate: {
                ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
                ...(q.to ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ changeDate: 'asc' }, { changedAt: 'asc' }],
      take: 500,
    });
    const keyword = q.query ? normalizeSeoKeyword(q.query) : null;
    const urlKey = q.url ? seoUrlKey(q.url) : null;
    return rows
      .filter((r) => !domainId || (r.domainId ?? primary) === domainId)
      .filter((r) => {
        if (!keyword && !urlKey) return true;
        if (r.urlKeys.length === 0 && r.keywords.length === 0) return true;
        if (keyword && r.keywords.includes(keyword)) return true;
        return (
          !!urlKey &&
          r.urlKeys.some(
            (k) => k === urlKey || seoPageMatchesKey(q.url!, k) || seoPageMatchesKey(k, urlKey),
          )
        );
      })
      .map((r) => ({ id: r.id, date: dateOnly(r.changeDate)!, title: r.title }));
  }

  // ------------------------------------------------------------- cambios

  async create(
    owner: SeoOwner,
    projectId: string,
    input: CreateSeoSiteChangeInput,
    actor: SeoActor,
  ): Promise<SeoSiteChangeDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const source = await loadPlanSource(this.admin, projectId, input);
    await assertPlanLinks(this.admin, projectId, { taskId: input.taskId ?? null });
    const urls = input.urls ?? (source ? source.urls : []);
    const keywords = input.keywords ?? (source ? source.keywords : []);
    const scope = seoSiteChangeScope({ urls, keywords });
    const domainId = resolveDomainId(project, input.domainId ?? source?.domainId ?? null);
    const time = input.time ?? null;
    const row = await this.admin.$transaction(async (tx) => {
      const created = await tx.seoSiteChange.create({
        data: {
          tenantId: project.tenantId,
          projectId,
          domainId,
          changeDate: new Date(`${input.date}T00:00:00Z`),
          changedAt: changedAt(input.date, time),
          changeTime: time,
          type: input.type,
          title: input.title,
          description: input.description ?? null,
          urls: [...new Set(urls.map((u) => u.trim()).filter(Boolean))],
          urlKeys: scope.urlKeys,
          keywords: scope.keywords,
          notes: input.notes ?? null,
          opportunityId: input.opportunityId ?? null,
          cannibalizationId: input.cannibalizationId ?? null,
          indexFindingId: input.indexFindingId ?? null,
          taskId: input.taskId ?? null,
          createdByUserId: actor.userId ?? null,
          createdBySuperAdminId: actor.superAdminId ?? null,
        },
      });
      // La tarea de la que sale queda enlazada a su actuación.
      if (input.taskId) {
        await tx.seoTask.update({ where: { id: input.taskId }, data: { changeId: created.id } });
      }
      return created;
    });
    const [dto] = await this.toDtos(project, [row], false);
    return dto!;
  }

  async update(
    owner: SeoOwner,
    projectId: string,
    id: string,
    input: UpdateSeoSiteChangeInput,
  ): Promise<SeoSiteChangeDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const row = await this.findRow(projectId, id);
    await assertPlanLinks(this.admin, projectId, {
      opportunityId: input.opportunityId ?? null,
      cannibalizationId: input.cannibalizationId ?? null,
      indexFindingId: input.indexFindingId ?? null,
      taskId: input.taskId ?? null,
    });
    const data: Prisma.SeoSiteChangeUpdateInput = {};
    if (input.domainId !== undefined) data.domainId = resolveDomainId(project, input.domainId);
    const date = input.date ?? dateOnly(row.changeDate)!;
    const time = input.time !== undefined ? input.time : row.changeTime;
    if (input.date !== undefined || input.time !== undefined) {
      data.changeDate = new Date(`${date}T00:00:00Z`);
      data.changedAt = changedAt(date, time);
      data.changeTime = time;
    }
    if (input.type !== undefined) data.type = input.type;
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description || null;
    if (input.notes !== undefined) data.notes = input.notes || null;
    if (input.urls !== undefined || input.keywords !== undefined) {
      const urls = input.urls ?? row.urls;
      const scope = seoSiteChangeScope({ urls, keywords: input.keywords ?? row.keywords });
      data.urls = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
      data.urlKeys = scope.urlKeys;
      data.keywords = scope.keywords;
    }
    if (input.opportunityId !== undefined) data.opportunityId = input.opportunityId;
    if (input.cannibalizationId !== undefined) data.cannibalizationId = input.cannibalizationId;
    if (input.indexFindingId !== undefined) data.indexFindingId = input.indexFindingId;
    const updated = await this.admin.$transaction(async (tx) => {
      if (input.taskId !== undefined) {
        data.taskId = input.taskId;
        if (input.taskId) {
          await tx.seoTask.update({ where: { id: input.taskId }, data: { changeId: row.id } });
        }
      }
      return tx.seoSiteChange.update({ where: { id: row.id }, data });
    });
    const [dto] = await this.toDtos(project, [updated], false);
    return dto!;
  }

  async remove(owner: SeoOwner, projectId: string, id: string): Promise<void> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.findRow(projectId, id);
    await this.admin.seoSiteChange.delete({ where: { id: row.id } });
  }

  // ------------------------------------------------------------------- CSV

  async csv(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoSiteChangeQuery,
  ): Promise<string> {
    const project = await this.projects.resolveProject(owner, projectId);
    const rows = await this.admin.seoSiteChange.findMany({
      where: this.where(projectId, q),
      orderBy: [{ changeDate: 'desc' }, { changedAt: 'desc' }, { id: 'asc' }],
      take: SEO_SITE_CHANGE_CSV_MAX,
    });
    const dtos = await this.toDtos(project, rows, false);
    const header = [
      'Fecha',
      'Hora',
      'Dominio',
      'Tipo',
      'Título',
      'Descripción',
      'URLs',
      'Palabras',
      'Quién',
      'Tarea',
      'Notas',
    ];
    for (const n of SEO_SITE_CHANGE_WINDOWS) {
      header.push(
        `${n} días: resultado`,
        `${n} días: clics antes`,
        `${n} días: clics después`,
        `${n} días: impresiones antes`,
        `${n} días: impresiones después`,
        `${n} días: posición antes`,
        `${n} días: posición después`,
        `${n} días: solapada con`,
      );
    }
    const lines = [header.map(csvCell).join(';')];
    for (const d of dtos) {
      const cells = [
        csvCell(d.date),
        csvCell(d.time),
        csvCell(d.domain),
        csvCell(SEO_SITE_CHANGE_TYPE_LABELS[d.type] ?? d.type),
        csvLineCell(d.title),
        csvLineCell(d.description),
        csvCell(d.urls.join(' ')),
        csvCell(d.keywords.join(', ')),
        csvCell(d.createdByName),
        csvLineCell(d.taskTitle),
        csvLineCell(d.notes),
      ];
      for (const w of d.windows) {
        const s = w.scope;
        cells.push(
          csvCell(
            s
              ? SEO_SITE_CHANGE_VERDICT_LABELS[s.verdict]
              : w.status === 'waiting'
                ? `Disponible el ${w.availableOn}`
                : w.status === 'no_history'
                  ? 'Sin histórico'
                  : 'Periodo incompleto',
          ),
          csvCell(s?.before.clicks ?? null),
          csvCell(s?.after.clicks ?? null),
          csvCell(s?.before.impressions ?? null),
          csvCell(s?.after.impressions ?? null),
          csvCell(s?.before.position ?? null),
          csvCell(s?.after.position ?? null),
          csvLineCell(w.overlaps.map((o) => `${o.date} ${o.title}`).join(' · ')),
        );
      }
      lines.push(cells.join(';'));
    }
    return CSV_BOM + lines.join('\r\n');
  }

  // ------------------------------------------------------ antes y después

  private async bounds(domainId: string): Promise<{ first: string | null; last: string | null }> {
    const b = await this.admin.seoGscMetric.aggregate({
      where: { domainId, grain: 'site' },
      _min: { date: true },
      _max: { date: true },
    });
    return { first: dateOnly(b._min.date), last: dateOnly(b._max.date) };
  }

  /** Lo de Google del alcance de una actuación entre dos fechas. */
  private async scopeData(
    domainId: string,
    row: Pick<Row, 'urls' | 'urlKeys' | 'keywords'>,
    from: string,
    to: string,
  ): Promise<ScopeData> {
    const sumSql = Prisma.sql`SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
      SUM(position * impressions)::float8 AS w, SUM(position)::float8 AS ps, COUNT(*)::float8 AS n`;
    const siteRows = await this.admin.$queryRaw<SqlSumRow[]>(Prisma.sql`
      SELECT '' AS k, date, ${sumSql}
      FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = 'site'
        AND date BETWEEN ${from}::date AND ${to}::date
      GROUP BY date`);
    const site: Sums = new Map(siteRows.map((r) => [dateOnly(new Date(r.date))!, toSums(r)]));

    const byUrl = new Map<string, Sums>();
    // El alcance entero por URL: cada fila de Google una vez, aunque case con
    // dos URLs apuntadas (variantes de la misma página).
    const urlTotal: Sums = new Map();
    if (row.urlKeys.length > 0) {
      // Primero se acota por la ruta (en SQL); la comparación exacta, normalizada, aquí.
      const patterns = row.urlKeys.map((k) => {
        const slash = k.indexOf('/');
        const path = (slash >= 0 ? k.slice(slash) : k).split('?')[0]!;
        return `%${path.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      });
      const pageRows = await this.admin.$queryRaw<SqlSumRow[]>(Prisma.sql`
        SELECT page AS k, date, ${sumSql}
        FROM seo_gsc_metrics
        WHERE domain_id = ${domainId}::uuid AND grain = 'page'
          AND date BETWEEN ${from}::date AND ${to}::date
          AND lower(page) LIKE ANY(${patterns}::text[])
        GROUP BY page, date`);
      for (const key of row.urlKeys) byUrl.set(key, new Map());
      for (const r of pageRows) {
        const date = dateOnly(new Date(r.date))!;
        let matched = false;
        for (const key of row.urlKeys) {
          if (!seoPageMatchesKey(r.k, key)) continue;
          matched = true;
          const m = byUrl.get(key)!;
          m.set(date, addSums(m.get(date), toSums(r)));
        }
        if (matched) urlTotal.set(date, addSums(urlTotal.get(date), toSums(r)));
      }
    }
    const byKeyword = new Map<string, Sums>();
    if (row.keywords.length > 0) {
      const queryRows = await this.admin.$queryRaw<SqlSumRow[]>(Prisma.sql`
        SELECT lower(query) AS k, date, ${sumSql}
        FROM seo_gsc_metrics
        WHERE domain_id = ${domainId}::uuid AND grain = 'query'
          AND date BETWEEN ${from}::date AND ${to}::date
          AND lower(query) = ANY(${row.keywords}::text[])
        GROUP BY lower(query), date`);
      for (const k of row.keywords) byKeyword.set(k, new Map());
      for (const r of queryRows) {
        const m = byKeyword.get(r.k);
        if (!m) continue;
        const date = dateOnly(new Date(r.date))!;
        m.set(date, addSums(m.get(date), toSums(r)));
      }
    }
    // El alcance entero: las URLs o, si no hay, las palabras; sin alcance, todo el sitio.
    let total: Sums = site;
    if (row.urlKeys.length > 0) total = urlTotal;
    else if (row.keywords.length > 0) {
      total = new Map();
      for (const m of byKeyword.values())
        for (const [date, s] of m) total.set(date, addSums(total.get(date), s));
    }
    return { total, byUrl, byKeyword, site };
  }

  /**
   * Las tres ventanas de cada actuación. Solo se piden a la base de datos los
   * datos de las que ya se pueden comparar (o todos, en la ficha).
   */
  private async toDtos(
    project: ProjectRow,
    rows: Row[],
    withItems: boolean,
  ): Promise<SeoSiteChangeDto[]> {
    if (rows.length === 0) return [];
    const now = today();
    const primary = resolveDomainId(project, null);
    const domainName = new Map(project.domains.map((d) => [d.id, d.domain]));

    // Otras actuaciones del proyecto cerca de estas (para los solapamientos).
    const dates = rows.map((r) => dateOnly(r.changeDate)!).sort();
    const near = await this.admin.seoSiteChange.findMany({
      where: {
        projectId: project.id,
        changeDate: {
          gte: new Date(`${shiftDate(dates[0]!, -2 * MAX_WINDOW)}T00:00:00Z`),
          lte: new Date(`${shiftDate(dates[dates.length - 1]!, 2 * MAX_WINDOW)}T00:00:00Z`),
        },
      },
      select: {
        id: true,
        changeDate: true,
        title: true,
        domainId: true,
        urlKeys: true,
        keywords: true,
      },
    });
    const overlapInputs: SeoSiteChangeOverlapInput[] = near.map((n) => ({
      id: n.id,
      date: dateOnly(n.changeDate)!,
      title: n.title,
      domainId: n.domainId ?? primary,
      urlKeys: n.urlKeys,
      keywords: n.keywords,
    }));

    const boundsCache = new Map<string, Promise<{ first: string | null; last: string | null }>>();
    const boundsOf = (domainId: string) => {
      if (!boundsCache.has(domainId)) boundsCache.set(domainId, this.bounds(domainId));
      return boundsCache.get(domainId)!;
    };

    const [names, tasks] = await Promise.all([
      personNames(
        this.admin,
        rows.map((r) => r.createdByUserId),
        rows.map((r) => r.createdBySuperAdminId),
      ),
      this.admin.seoTask.findMany({
        where: { id: { in: rows.flatMap((r) => (r.taskId ? [r.taskId] : [])) } },
        select: { id: true, title: true },
      }),
    ]);
    const taskTitle = new Map(tasks.map((t) => [t.id, t.title]));

    return Promise.all(
      rows.map(async (r): Promise<SeoSiteChangeDto> => {
        const date = dateOnly(r.changeDate)!;
        const domainId = r.domainId ?? primary;
        const target: SeoSiteChangeOverlapInput = {
          id: r.id,
          date,
          title: r.title,
          domainId,
          urlKeys: r.urlKeys,
          keywords: r.keywords,
        };
        const windows = await this.windows(r, domainId, date, now, withItems, boundsOf, (days) =>
          seoOverlappingChanges(target, overlapInputs, days).map((o) => ({
            id: o.id,
            title: o.title,
            date: o.date,
          })),
        );
        return {
          id: r.id,
          projectId: r.projectId,
          domainId,
          domain: domainId ? (domainName.get(domainId) ?? null) : null,
          date,
          time: r.changeTime,
          changedAt: r.changedAt.toISOString(),
          type: r.type as SeoSiteChangeType,
          title: r.title,
          description: r.description,
          urls: r.urls,
          keywords: r.keywords,
          notes: r.notes,
          createdByName:
            names.get(r.createdByUserId ?? '') ?? names.get(r.createdBySuperAdminId ?? '') ?? null,
          opportunityId: r.opportunityId,
          cannibalizationId: r.cannibalizationId,
          indexFindingId: r.indexFindingId,
          taskId: r.taskId,
          taskTitle: r.taskId ? (taskTitle.get(r.taskId) ?? null) : null,
          windows,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        };
      }),
    );
  }

  private async windows(
    r: Row,
    domainId: string | null,
    date: string,
    now: string,
    withItems: boolean,
    boundsOf: (domainId: string) => Promise<{ first: string | null; last: string | null }>,
    overlapsOf: (days: number) => SeoSiteChangeWindowDto['overlaps'],
  ): Promise<SeoSiteChangeWindowDto[]> {
    const bounds = domainId ? await boundsOf(domainId) : { first: null, last: null };
    const maxRange = seoSiteChangeRange(date, MAX_WINDOW);
    // Días con datos del dominio (cruce `site`), para saber si la ventana está completa.
    const siteDays = new Set<string>();
    if (domainId && bounds.last) {
      const days = await this.admin.seoGscMetric.findMany({
        where: {
          domainId,
          grain: 'site',
          date: {
            gte: new Date(`${maxRange.beforeFrom}T00:00:00Z`),
            lte: new Date(`${maxRange.afterTo}T00:00:00Z`),
          },
        },
        select: { date: true },
      });
      for (const d of days) siteDays.add(dateOnly(d.date)!);
    }
    const count = (from: string, to: string) => {
      let n = 0;
      for (const d of siteDays) if (d >= from && d <= to) n++;
      return n;
    };
    const states = SEO_SITE_CHANGE_WINDOWS.map((days) => {
      const range = seoSiteChangeRange(date, days);
      return {
        days,
        range,
        state: seoSiteChangeWindowState({
          changeDate: date,
          days,
          today: now,
          firstDataDate: bounds.first,
          lastDataDate: bounds.last,
          daysWithDataBefore: count(range.beforeFrom, range.beforeTo),
          daysWithDataAfter: count(range.afterFrom, range.afterTo),
        }),
      };
    });
    const ready = states.filter((s) => s.state.status === 'ready');
    let data: ScopeData | null = null;
    if (domainId && ready.length > 0) {
      const widest = Math.max(...ready.map((s) => s.days));
      const range = seoSiteChangeRange(date, widest);
      data = await this.scopeData(domainId, r, range.beforeFrom, range.afterTo);
    }
    const labelOf = new Map<string, string>();
    for (const u of r.urls) {
      const key = seoUrlKey(u);
      if (key && !labelOf.has(key)) labelOf.set(key, u);
    }
    return states.map(({ days, range, state }): SeoSiteChangeWindowDto => {
      const base: SeoSiteChangeWindowDto = {
        days,
        ...range,
        status: state.status,
        availableOn: state.availableOn,
        daysLeft: state.daysLeft,
        scope: null,
        site: null,
        contextNote: null,
        items: [],
        overlaps: overlapsOf(days),
      };
      if (state.status !== 'ready' || !data) return base;
      const scopeOnly = r.urlKeys.length === 0 && r.keywords.length === 0;
      const siteBefore = sumRange(data.site, range.beforeFrom, range.beforeTo);
      const siteAfter = sumRange(data.site, range.afterFrom, range.afterTo);
      const before = sumRange(data.total, range.beforeFrom, range.beforeTo);
      const after = sumRange(data.total, range.afterFrom, range.afterTo);
      const verdict = seoSiteChangeVerdict({
        before,
        after,
        site: scopeOnly ? null : { before: siteBefore, after: siteAfter },
      });
      const item = (kind: 'url' | 'keyword', label: string, sums: Sums): SeoSiteChangeItemDto => {
        const b = sumRange(sums, range.beforeFrom, range.beforeTo);
        const a = sumRange(sums, range.afterFrom, range.afterTo);
        const v = seoSiteChangeVerdict({ before: b, after: a });
        return {
          kind,
          label,
          before: b,
          after: a,
          variation: v.variation,
          verdict: v.verdict,
          text: v.text,
        };
      };
      const items: SeoSiteChangeItemDto[] = withItems
        ? [
            ...[...data.byUrl].map(([key, sums]) => item('url', labelOf.get(key) ?? key, sums)),
            ...[...data.byKeyword].map(([key, sums]) => item('keyword', key, sums)),
          ]
        : [];
      return {
        ...base,
        scope: {
          before,
          after,
          variation: verdict.variation,
          verdict: verdict.verdict,
          text: verdict.text,
        },
        site: {
          before: siteBefore,
          after: siteAfter,
          variation: scopeOnly ? null : seoChange(siteAfter, siteBefore),
        },
        contextNote: verdict.contextNote,
        items,
      };
    });
  }
}

/** Instante del cambio: el día (y la hora, si se sabe) en hora de España. */
function changedAt(date: string, time: string | null): Date {
  const start = zonedDayStart(date);
  if (!time) return start;
  const [h, m] = time.split(':').map(Number);
  return new Date(start.getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60_000);
}

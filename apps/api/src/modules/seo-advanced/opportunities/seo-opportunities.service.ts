import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_DEFAULT_OPPORTUNITY_THRESHOLDS,
  SEO_DEFAULT_WEIGHTS,
  SEO_OPPORTUNITY_CSV_MAX,
  SEO_OPPORTUNITY_OPEN_STATUSES,
  SEO_OPPORTUNITY_PAGE_SIZE,
  SEO_OPPORTUNITY_SOURCE_LABELS,
  SEO_OPPORTUNITY_STATUSES,
  SEO_OPPORTUNITY_STATUS_LABELS,
  SEO_OPPORTUNITY_TYPES,
  SEO_OPPORTUNITY_TYPE_LABELS,
  normalizeSeoKeyword,
  normalizeSeoUrl,
  seoInspectionUrlKey,
  seoThresholdsOf,
  seoWeightsOf,
  shiftDate,
  type SeoOpportunityAssigneeDto,
  type SeoOpportunityDetailDto,
  type SeoOpportunityFactorDto,
  type SeoOpportunityMetricsDto,
  type SeoOpportunityPageDto,
  type SeoOpportunityRecalcDto,
  type SeoOpportunitySettingsDto,
  type SeoOpportunitySort,
  type SeoOpportunitySource,
  type SeoOpportunityStatus,
  type SeoOpportunitySummaryDto,
  type SeoOpportunityType,
  type SeoProviderKey,
  type SeoScoredOpportunityDto,
  type SeoUrlIndexStatusDto,
  type UpdateSeoOpportunityInput,
  type UpdateSeoOpportunitySettingsInput,
} from '@storageos/shared';

import { CSV_BOM, csvCell, csvLineCell } from '../../../common/csv';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoProjectsService, type SeoOwner } from '../seo-projects.service';
import { poolOfProject } from '../sistrix/sistrix-sync.service';
import { SeoTechnicalReadService } from '../technical/seo-technical-read.service';

import { SeoOpportunityEngineService } from './seo-opportunity-engine.service';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Días de evolución diaria en la ficha de una oportunidad. */
const DETAIL_DAYS = 90;

export interface SeoOpportunityQuery {
  types?: SeoOpportunityType[] | undefined;
  statuses?: SeoOpportunityStatus[] | undefined;
  minScore?: number | undefined;
  search?: string | undefined;
  domainId?: string | undefined;
  sort?: SeoOpportunitySort | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

type Row = Prisma.SeoOpportunityGetPayload<object>;

/** Lee los filtros de la petición (listas separadas por comas). */
export function parseSeoOpportunityQuery(
  q: Record<string, string | undefined>,
): SeoOpportunityQuery {
  const list = <T extends string>(value: string | undefined, allowed: readonly T[]) =>
    value
      ? value
          .split(',')
          .map((v) => v.trim())
          .filter((v): v is T => (allowed as readonly string[]).includes(v))
      : undefined;
  const num = (v: string | undefined) => (v !== undefined && v !== '' ? Number(v) : undefined);
  const sort = q.sort === 'detected' || q.sort === 'updated' ? q.sort : 'score';
  return {
    types: list(q.type, SEO_OPPORTUNITY_TYPES),
    statuses: list(q.status, SEO_OPPORTUNITY_STATUSES),
    minScore: num(q.minScore),
    search: q.search?.trim() || undefined,
    domainId: q.domainId || undefined,
    sort,
    offset: num(q.offset),
    limit: num(q.limit),
  };
}

/**
 * Oportunidades de un proyecto para las pantallas: lista con filtros, resumen,
 * ficha con sus datos, cambios de estado y asignación, CSV y pesos/umbrales.
 * Con dueño (`tenantId` o `null` = la plataforma), solo las suyas; sin dueño
 * (`undefined`), el super admin leyendo cualquier proyecto.
 */
@Injectable()
export class SeoOpportunitiesService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly engine: SeoOpportunityEngineService,
    private readonly technical: SeoTechnicalReadService,
  ) {}

  private notFound() {
    return new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
  }

  // --------------------------------------------------------------- lista

  private where(projectId: string, q: SeoOpportunityQuery): Prisma.SeoOpportunityWhereInput {
    const statuses = q.statuses?.length ? q.statuses : SEO_OPPORTUNITY_OPEN_STATUSES;
    const search = q.search?.slice(0, 200);
    return {
      projectId,
      status: { in: statuses },
      // Las pendientes, solo si siguen saliendo; hechas y descartadas, siempre.
      OR: [{ active: true }, { status: { in: ['done', 'dismissed'] } }],
      ...(q.types?.length ? { type: { in: q.types } } : {}),
      ...(q.minScore !== undefined && Number.isFinite(q.minScore)
        ? { score: { gte: Math.max(0, Math.min(100, Math.round(q.minScore))) } }
        : {}),
      ...(search ? { query: { contains: search, mode: 'insensitive' } } : {}),
      ...(q.domainId ? { domainId: q.domainId } : {}),
    };
  }

  private orderBy(
    sort: SeoOpportunitySort | undefined,
  ): Prisma.SeoOpportunityOrderByWithRelationInput[] {
    if (sort === 'detected') return [{ detectedAt: 'desc' }, { score: 'desc' }, { id: 'asc' }];
    if (sort === 'updated') return [{ updatedAt: 'desc' }, { score: 'desc' }, { id: 'asc' }];
    return [{ score: 'desc' }, { detectedAt: 'desc' }, { id: 'asc' }];
  }

  async list(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoOpportunityQuery,
  ): Promise<SeoOpportunityPageDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const limit = Math.min(Math.max(1, q.limit ?? SEO_OPPORTUNITY_PAGE_SIZE), 200);
    const offset = Math.max(0, q.offset ?? 0);
    const where = this.where(projectId, q);
    const [total, rows] = await Promise.all([
      this.admin.seoOpportunity.count({ where }),
      this.admin.seoOpportunity.findMany({
        where,
        orderBy: this.orderBy(q.sort),
        skip: offset,
        take: limit,
      }),
    ]);
    return {
      total,
      offset,
      limit,
      hasMore: offset + rows.length < total,
      calculatedAt: iso(project.opportunitiesCalculatedAt),
      items: await this.toDtos(rows),
    };
  }

  async summary(owner: SeoOwner | undefined, projectId: string): Promise<SeoOpportunitySummaryDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const open = { projectId, active: true, status: { in: SEO_OPPORTUNITY_OPEN_STATUSES } };
    const [byType, byStatus, top, returned] = await Promise.all([
      this.admin.seoOpportunity.groupBy({ by: ['type'], where: open, _count: { _all: true } }),
      this.admin.seoOpportunity.groupBy({
        by: ['status'],
        where: { projectId, OR: [{ active: true }, { status: { in: ['done', 'dismissed'] } }] },
        _count: { _all: true },
      }),
      this.admin.seoOpportunity.findMany({
        where: open,
        orderBy: this.orderBy('score'),
        take: 5,
      }),
      this.admin.seoOpportunity.count({
        where: { ...open, status: 'new', returnedAt: { not: null } },
      }),
    ]);
    const types = Object.fromEntries(SEO_OPPORTUNITY_TYPES.map((t) => [t, 0])) as Record<
      SeoOpportunityType,
      number
    >;
    for (const r of byType) types[r.type as SeoOpportunityType] = r._count._all;
    const statuses = Object.fromEntries(SEO_OPPORTUNITY_STATUSES.map((s) => [s, 0])) as Record<
      SeoOpportunityStatus,
      number
    >;
    for (const r of byStatus) statuses[r.status as SeoOpportunityStatus] = r._count._all;
    return {
      calculatedAt: iso(project.opportunitiesCalculatedAt),
      byType: types,
      byStatus: statuses,
      top: await this.toDtos(top),
      returned,
    };
  }

  // -------------------------------------------------------------- ficha

  private async findRow(projectId: string, opportunityId: string): Promise<Row> {
    const row = await this.admin.seoOpportunity.findFirst({
      where: { id: opportunityId, projectId },
    });
    if (!row) throw this.notFound();
    return row;
  }

  async detail(
    owner: SeoOwner | undefined,
    projectId: string,
    opportunityId: string,
  ): Promise<SeoOpportunityDetailDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const row = await this.findRow(projectId, opportunityId);
    const [dto] = await this.toDtos([row]);
    const metrics = row.metrics as unknown as SeoOpportunityMetricsDto;
    const domainId = row.domainId;
    let daily: SeoOpportunityDetailDto['daily'] = [];
    let pages: SeoOpportunityDetailDto['pages'] = [];
    if (domainId) {
      const last = await this.admin.seoGscMetric.aggregate({
        where: { domainId, grain: 'site' },
        _max: { date: true },
      });
      const to = dateOnly(last._max.date);
      if (to) {
        const from = shiftDate(to, -(DETAIL_DAYS - 1));
        const rows = await this.admin.$queryRaw<
          { date: Date; c: number; i: number; w: number; ps: number; n: number }[]
        >(Prisma.sql`
          SELECT date, SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
            SUM(position * impressions)::float8 AS w, SUM(position)::float8 AS ps,
            COUNT(*)::float8 AS n
          FROM seo_gsc_metrics
          WHERE domain_id = ${domainId}::uuid AND grain = 'query' AND query = ${row.query}
            AND date BETWEEN ${from}::date AND ${to}::date
          GROUP BY date ORDER BY date`);
        const byDate = new Map(rows.map((r) => [dateOnly(new Date(r.date))!, r]));
        for (let d = from; d <= to; d = shiftDate(d, 1)) {
          const r = byDate.get(d);
          const i = Number(r?.i ?? 0);
          daily.push({
            date: d,
            clicks: Number(r?.c ?? 0),
            impressions: i,
            ctr: r && i > 0 ? Math.round((Number(r.c) / i) * 1000) / 1000 : null,
            position: r
              ? Math.round((i > 0 ? Number(r.w) / i : Number(r.ps) / Number(r.n)) * 10) / 10
              : null,
          });
        }
        const pFrom = metrics.gsc?.from ?? shiftDate(to, -27);
        const pTo = metrics.gsc?.to ?? to;
        const pageRows = await this.admin.$queryRaw<
          { page: string; c: number; i: number; w: number; ps: number; n: number }[]
        >(Prisma.sql`
          SELECT page, SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
            SUM(position * impressions)::float8 AS w, SUM(position)::float8 AS ps,
            COUNT(*)::float8 AS n
          FROM seo_gsc_metrics
          WHERE domain_id = ${domainId}::uuid AND grain = 'query_page' AND query = ${row.query}
            AND date BETWEEN ${pFrom}::date AND ${pTo}::date
          GROUP BY page ORDER BY c DESC, i DESC, page ASC LIMIT 20`);
        pages = pageRows.map((r) => {
          const i = Number(r.i);
          return {
            page: r.page,
            clicks: Number(r.c),
            impressions: i,
            position: Math.round((i > 0 ? Number(r.w) / i : Number(r.ps) / Number(r.n)) * 10) / 10,
            index: null as SeoUrlIndexStatusDto | null,
          };
        });
      }
      if (daily.every((d) => d.impressions === 0)) daily = [];
    }

    // Resultados de Google de la búsqueda (si se han pedido para tus palabras).
    let serp: SeoOpportunityDetailDto['serp'] = null;
    const keyword = await this.admin.seoKeyword.findFirst({
      where: {
        keyword: normalizeSeoKeyword(row.query),
        country: project.country.toUpperCase(),
      },
      select: { id: true },
    });
    if (keyword) {
      const pool = poolOfProject(project);
      const latest = await this.admin.seoSerpResult.findFirst({
        where: { tenantId: pool, keywordId: keyword.id },
        orderBy: { sampleDate: 'desc' },
      });
      if (latest) {
        const results = await this.admin.seoSerpResult.findMany({
          where: {
            tenantId: pool,
            keywordId: keyword.id,
            sampleDate: latest.sampleDate,
            provider: latest.provider,
          },
          orderBy: { position: 'asc' },
          take: 20,
        });
        const competitors = await this.admin.seoCompetitor.findMany({
          where: { projectId, isActive: true },
          select: { domain: true },
        });
        const own = new Set(project.domains.map((d) => d.domain));
        const comp = new Set(competitors.map((c) => c.domain));
        const strip = (d: string) => d.replace(/^www\./, '');
        serp = {
          origin: {
            provider: latest.provider as SeoProviderKey,
            fetchedAt: latest.fetchedAt.toISOString(),
            dataDate: dateOnly(latest.sampleDate),
          },
          results: results.map((r) => ({
            position: r.position,
            domain: r.domain,
            url: r.url,
            own: own.has(strip(r.domain)),
            competitor: comp.has(strip(r.domain)),
          })),
        };
      }
    }
    // Lo que dice Google de sus páginas (última inspección de URL, PR 9).
    const primary = project.domains.find((d) => d.role === 'primary')?.domain ?? '';
    const ownDomain = row.domain || primary;
    const mainUrl = dto!.page ?? dto!.targetUrl;
    const keys = [
      ...pages.map((p) => normalizeSeoUrl(p.page)),
      ...(mainUrl ? [seoInspectionUrlKey(mainUrl, ownDomain)] : []),
    ];
    const statuses = await this.technical.indexStatuses(projectId, keys);
    pages = pages.map((p) => ({ ...p, index: statuses.get(normalizeSeoUrl(p.page)) ?? null }));
    const urlIndex = mainUrl
      ? (statuses.get(seoInspectionUrlKey(mainUrl, ownDomain)) ?? null)
      : null;
    return { ...dto!, daily, pages, serp, urlIndex };
  }

  // ------------------------------------------------------------- cambios

  async update(
    owner: SeoOwner,
    projectId: string,
    opportunityId: string,
    input: UpdateSeoOpportunityInput,
  ): Promise<SeoScoredOpportunityDto> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.findRow(projectId, opportunityId);
    const data: Prisma.SeoOpportunityUpdateInput = {};
    if (input.status !== undefined && input.status !== row.status) {
      data.status = input.status;
      if (input.status === 'dismissed') {
        data.dismissReason = input.dismissReason ?? null;
        data.dismissedScore = row.score;
        data.resolvedAt = new Date();
      } else if (input.status === 'done') {
        data.resolvedAt = new Date();
        data.dismissReason = null;
        data.dismissedScore = null;
      } else {
        data.resolvedAt = null;
        data.dismissReason = null;
        data.dismissedScore = null;
      }
    } else if (input.dismissReason !== undefined && row.status === 'dismissed') {
      data.dismissReason = input.dismissReason;
    }
    if (input.notes !== undefined) data.notes = input.notes || null;
    if (input.assignedToId !== undefined) {
      const id = input.assignedToId;
      if (id !== null) await this.assertAssignee(owner, id);
      if (owner) data.assignedToUserId = id;
      else data.assignedToSuperAdminId = id;
    }
    const updated = await this.admin.seoOpportunity.update({
      where: { id: row.id },
      data,
    });
    const [dto] = await this.toDtos([updated]);
    return dto!;
  }

  private async assertAssignee(owner: SeoOwner, id: string): Promise<void> {
    const ok = owner
      ? await this.admin.user.count({ where: { id, tenantId: owner, isActive: true } })
      : await this.admin.superAdmin.count({ where: { id, isActive: true } });
    if (!ok) {
      throw new BadRequestException({
        code: 'seo_assignee_invalid',
        message: 'Esa persona no puede llevar esta oportunidad.',
      });
    }
  }

  /** Personas a las que se puede asignar (el equipo del negocio o los super admins). */
  async assignees(
    owner: SeoOwner | undefined,
    projectId: string,
  ): Promise<SeoOpportunityAssigneeDto[]> {
    const project = await this.projects.resolveProject(owner, projectId);
    if (project.tenantId) {
      const users = await this.admin.user.findMany({
        where: { tenantId: project.tenantId, isActive: true },
        select: { id: true, fullName: true },
        orderBy: { fullName: 'asc' },
        take: 200,
      });
      return users.map((u) => ({ id: u.id, name: u.fullName }));
    }
    const admins = await this.admin.superAdmin.findMany({
      where: { isActive: true },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });
    return admins.map((a) => ({ id: a.id, name: a.fullName }));
  }

  async recalculate(owner: SeoOwner, projectId: string): Promise<SeoOpportunityRecalcDto> {
    await this.projects.resolveProject(owner, projectId);
    const res = await this.engine.recalculate(projectId);
    if (!res) throw this.notFound();
    return res;
  }

  // --------------------------------------------------------------- ajustes

  async settings(
    owner: SeoOwner | undefined,
    projectId: string,
  ): Promise<SeoOpportunitySettingsDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    return {
      weights: seoWeightsOf(project.weights),
      thresholds: seoThresholdsOf(project.opportunitySettings),
      defaults: {
        weights: { ...SEO_DEFAULT_WEIGHTS },
        thresholds: { ...SEO_DEFAULT_OPPORTUNITY_THRESHOLDS },
      },
    };
  }

  /** Guarda pesos y umbrales y recalcula (las puntuaciones cambian). */
  async updateSettings(
    owner: SeoOwner,
    projectId: string,
    input: UpdateSeoOpportunitySettingsInput,
  ): Promise<SeoOpportunitySettingsDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const weights = input.reset
      ? {}
      : { ...seoWeightsOf(project.weights), ...stripUndefined(input.weights ?? {}) };
    const thresholds = input.reset
      ? {}
      : {
          ...seoThresholdsOf(project.opportunitySettings),
          ...stripUndefined(input.thresholds ?? {}),
        };
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: {
        weights: weights as Prisma.InputJsonValue,
        opportunitySettings: thresholds as Prisma.InputJsonValue,
      },
    });
    await this.engine.recalculate(projectId);
    return this.settings(owner, projectId);
  }

  // ------------------------------------------------------------------- CSV

  async csv(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoOpportunityQuery,
  ): Promise<string> {
    await this.projects.resolveProject(owner, projectId);
    const rows = await this.admin.seoOpportunity.findMany({
      where: this.where(projectId, q),
      orderBy: this.orderBy(q.sort),
      take: SEO_OPPORTUNITY_CSV_MAX,
    });
    const header = [
      'Puntuación',
      'Confianza (%)',
      'Tipo',
      'Búsqueda',
      'Dominio',
      'Página',
      'URL objetivo',
      'Estado',
      'Impresiones',
      'Clics',
      'CTR (%)',
      'Posición',
      'Volumen SISTRIX',
      'Competencia SISTRIX',
      'Orígenes',
      'Motivo',
      'Acción sugerida',
      'Notas',
      'Detectada',
      'Vista por última vez',
    ];
    const lines = [header.map(csvCell).join(';')];
    for (const r of rows) {
      const m = r.metrics as unknown as SeoOpportunityMetricsDto;
      lines.push(
        [
          csvCell(r.score),
          csvCell(Math.round(Number(r.confidence) * 100)),
          csvCell(SEO_OPPORTUNITY_TYPE_LABELS[r.type as SeoOpportunityType] ?? r.type),
          csvCell(r.query),
          csvCell(r.domain),
          csvCell(r.page),
          csvCell(r.targetUrl),
          csvCell(SEO_OPPORTUNITY_STATUS_LABELS[r.status as SeoOpportunityStatus] ?? r.status),
          csvCell(m.gsc?.impressions ?? null),
          csvCell(m.gsc?.clicks ?? null),
          csvCell(m.gsc?.ctr != null ? Math.round(m.gsc.ctr * 1000) / 10 : null),
          csvCell(m.gsc?.position ?? m.sistrix?.position ?? null),
          csvCell(m.sistrix?.volume ?? null),
          csvCell(m.sistrix?.competition ?? null),
          csvCell(
            r.sources
              .map((s) => SEO_OPPORTUNITY_SOURCE_LABELS[s as SeoOpportunitySource] ?? s)
              .join(', '),
          ),
          csvLineCell(r.reason),
          csvLineCell(r.action),
          csvLineCell(r.notes),
          csvCell(dateOnly(r.detectedAt)),
          csvCell(dateOnly(r.lastSeenAt)),
        ].join(';'),
      );
    }
    return CSV_BOM + lines.join('\r\n');
  }

  // ---------------------------------------------------------------- DTO

  private async toDtos(rows: Row[]): Promise<SeoScoredOpportunityDto[]> {
    const userIds = [
      ...new Set(rows.flatMap((r) => (r.assignedToUserId ? [r.assignedToUserId] : []))),
    ];
    const adminIds = [
      ...new Set(rows.flatMap((r) => (r.assignedToSuperAdminId ? [r.assignedToSuperAdminId] : []))),
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
    const names = new Map([...users, ...admins].map((u) => [u.id, u.fullName]));
    return rows.map((r) => {
      const assignedToId = r.assignedToUserId ?? r.assignedToSuperAdminId ?? null;
      return {
        id: r.id,
        projectId: r.projectId,
        domain: r.domain,
        type: r.type as SeoOpportunityType,
        query: r.query,
        page: r.page,
        targetUrl: r.targetUrl,
        score: r.score,
        confidence: Number(r.confidence),
        factors: r.factors as unknown as SeoOpportunityFactorDto[],
        metrics: r.metrics as unknown as SeoOpportunityMetricsDto,
        sources: r.sources as SeoOpportunitySource[],
        reason: r.reason,
        action: r.action,
        status: r.status as SeoOpportunityStatus,
        dismissReason: r.dismissReason,
        notes: r.notes,
        assignedToId,
        assignedToName: assignedToId ? (names.get(assignedToId) ?? null) : null,
        active: r.active,
        returnedAt: iso(r.returnedAt),
        detectedAt: r.detectedAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        resolvedAt: iso(r.resolvedAt),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

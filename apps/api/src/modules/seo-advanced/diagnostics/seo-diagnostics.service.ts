import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_CANNIBALIZATION_KINDS,
  SEO_CANNIBALIZATION_KIND_LABELS,
  SEO_DEFAULT_CANNIBALIZATION_THRESHOLDS,
  SEO_DEFAULT_INDEX_RULES,
  SEO_DIAGNOSTIC_OPEN_STATUSES,
  SEO_DIAGNOSTIC_STATUSES,
  SEO_DIAGNOSTIC_STATUS_LABELS,
  SEO_INDEX_CATEGORIES,
  SEO_INDEX_CATEGORY_LABELS,
  SEO_INDEX_EVIDENCE_LABELS,
  SEO_KEYWORD_CANDIDATES_MAX,
  SEO_KEYWORD_IMPORT_ALIASES,
  SEO_KEYWORD_INTENT_LABELS,
  SEO_KEYWORD_PRIORITY_LABELS,
  SEO_KEYWORD_SOURCE_LABELS,
  SEO_SEVERITIES,
  SEO_SEVERITY_LABELS,
  SEO_TARGET_STATUSES,
  SEO_TARGET_STATUS_LABELS,
  isBrandQuery,
  isSeoTrackedPeriod,
  normalizeSeoImportHeader,
  normalizeSeoKeyword,
  normalizeSeoUrl,
  seoInspectionUrlKey,
  planSeoKeywordImport,
  seoDailyWinners,
  seoDiagnosticSettingsOf,
  seoGroupTrackedKeywords,
  seoPageChanges,
  seoPeriodCovered,
  seoPeriodRange,
  seoRuleIntent,
  seoTargetStatus,
  seoTotalsFromSums,
  seoTrackedIntent,
  shiftDate,
  type SeoCannibalizationDto,
  type SeoCannibalizationKind,
  type SeoCannibalizationPageDto,
  type SeoCannibalizationSummaryDto,
  type SeoDataOriginDto,
  type SeoDiagnosticListDto,
  type SeoDiagnosticSettingsDto,
  type SeoDiagnosticStatus,
  type SeoDiagnosticsRecalcDto,
  type SeoIndexCategory,
  type SeoIndexFindingDto,
  type SeoUrlIndexStatusDto,
  type SeoIndexSummaryDto,
  type SeoKeywordCandidatesDto,
  type SeoKeywordImportExisting,
  type SeoKeywordImportField,
  type SeoKeywordImportInput,
  type SeoKeywordImportInputRow,
  type SeoKeywordImportPreviewDto,
  type SeoKeywordImportResultDto,
  type SeoKeywordIntent,
  type SeoKeywordSource,
  type SeoPageMetric,
  type SeoProviderKey,
  type SeoSeverity,
  type SeoSitemapsDto,
  type SeoTargetStatus,
  type SeoTrackedKeywordDetailDto,
  type SeoTrackedKeywordDto,
  type SeoTrackedKeywordsDto,
  type UpdateSeoDiagnosticInput,
  type UpdateSeoDiagnosticSettingsInput,
} from '@storageos/shared';

import { CSV_BOM, csvCell, csvLineCell } from '../../../common/csv';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { parseRaw, resolveImportCsv } from '../../imports/import-engine';
import { SeoOpportunityEngineService } from '../opportunities/seo-opportunity-engine.service';
import { SeoProjectsService, type ProjectRow, type SeoOwner } from '../seo-projects.service';
import { SeoSistrixService } from '../sistrix/seo-sistrix.service';
import { poolOfProject } from '../sistrix/sistrix-sync.service';
import { SeoTechnicalReadService } from '../technical/seo-technical-read.service';

import { SeoDiagnosticsEngineService } from './seo-diagnostics-engine.service';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Filas de un fichero de palabras que se leen como mucho. */
const IMPORT_MAX_ROWS = 5000;
/** Búsquedas que se miran como mucho para el alta desde Search Console. */
const CANDIDATE_SCAN = 3000;
/** Días por defecto de la ficha de una palabra. */
const DETAIL_DAYS = 90;
const LIST_MAX = 1000;

type SumsRow = { key: string; c: number; i: number; w: number; ps: number; n: number };
const totalsOf = (r: SumsRow | undefined) =>
  seoTotalsFromSums({
    clicks: Number(r?.c ?? 0),
    impressions: Number(r?.i ?? 0),
    weightedPosition: Number(r?.w ?? 0),
    positionSum: Number(r?.ps ?? 0),
    rows: Number(r?.n ?? 0),
  });
const SUMS = Prisma.sql`SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
  SUM(position * impressions)::float8 AS w, SUM(position)::float8 AS ps, COUNT(*)::float8 AS n`;

export interface SeoDiagnosticListQuery {
  statuses?: SeoDiagnosticStatus[] | undefined;
  severities?: SeoSeverity[] | undefined;
  kinds?: SeoCannibalizationKind[] | undefined;
  categories?: SeoIndexCategory[] | undefined;
  search?: string | undefined;
  domainId?: string | undefined;
}

/** Filtros de las listas (separados por comas). */
export function parseSeoDiagnosticQuery(
  q: Record<string, string | undefined>,
): SeoDiagnosticListQuery {
  const list = <T extends string>(value: string | undefined, allowed: readonly T[]) =>
    value
      ? value
          .split(',')
          .map((v) => v.trim())
          .filter((v): v is T => (allowed as readonly string[]).includes(v))
      : undefined;
  return {
    statuses: list(q.status, SEO_DIAGNOSTIC_STATUSES),
    severities: list(q.severity, SEO_SEVERITIES),
    kinds: list(q.kind, SEO_CANNIBALIZATION_KINDS),
    categories: list(q.category, SEO_INDEX_CATEGORIES),
    search: q.search?.trim().slice(0, 200) || undefined,
    domainId: q.domainId || undefined,
  };
}

/** Periodo y dominio de las palabras seguidas. */
export function parseSeoTrackedQuery(q: Record<string, string | undefined>): {
  days: number;
  domainId?: string | undefined;
} {
  const days = Number(q.days);
  return { days: isSeoTrackedPeriod(days) ? days : 28, domainId: q.domainId || undefined };
}

export interface SeoCandidateQuery {
  days: number;
  domainId?: string | undefined;
  minImpressions: number;
  minPosition?: number | undefined;
  maxPosition?: number | undefined;
  excludeBrand: boolean;
  excludeTracked: boolean;
  search?: string | undefined;
}

export function parseSeoCandidateQuery(q: Record<string, string | undefined>): SeoCandidateQuery {
  const num = (v: string | undefined) =>
    v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
  return {
    ...parseSeoTrackedQuery(q),
    minImpressions: Math.max(0, Math.min(1_000_000, num(q.minImpressions) ?? 10)),
    minPosition: num(q.minPosition),
    maxPosition: num(q.maxPosition),
    excludeBrand: q.excludeBrand !== '0' && q.excludeBrand !== 'false',
    excludeTracked: q.excludeTracked !== '0' && q.excludeTracked !== 'false',
    search: q.search?.trim().slice(0, 200) || undefined,
  };
}

/**
 * Diagnóstico de un proyecto para las pantallas (PR 5): palabras seguidas con
 * su evolución y su URL objetivo, alta de palabras desde Search Console y
 * desde CSV/Excel, canibalización e indexación con su estado y notas, y los
 * ajustes. Con dueño (`tenantId` o `null` = la plataforma), solo lo suyo; sin
 * dueño (`undefined`), el super admin leyendo cualquier proyecto.
 */
@Injectable()
export class SeoDiagnosticsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly engine: SeoDiagnosticsEngineService,
    private readonly opportunityEngine: SeoOpportunityEngineService,
    private readonly sistrix: SeoSistrixService,
    private readonly technical: SeoTechnicalReadService,
  ) {}

  private notFound() {
    return new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
  }

  // --------------------------------------------------------- ajustes

  async settings(
    owner: SeoOwner | undefined,
    projectId: string,
  ): Promise<SeoDiagnosticSettingsDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const s = seoDiagnosticSettingsOf(project.diagnosticSettings);
    return {
      ...s,
      defaults: {
        cannibalization: { ...SEO_DEFAULT_CANNIBALIZATION_THRESHOLDS },
        indexRules: [...SEO_DEFAULT_INDEX_RULES],
      },
    };
  }

  /** Guarda umbrales y reglas y recalcula. */
  async updateSettings(
    owner: SeoOwner,
    projectId: string,
    input: UpdateSeoDiagnosticSettingsInput,
  ): Promise<SeoDiagnosticSettingsDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const current = seoDiagnosticSettingsOf(project.diagnosticSettings);
    const stored: Record<string, unknown> = input.reset
      ? {}
      : {
          cannibalization: {
            ...current.cannibalization,
            ...Object.fromEntries(
              Object.entries(input.cannibalization ?? {}).filter(([, v]) => v !== undefined),
            ),
          },
          ...(input.indexRules !== undefined
            ? { indexRules: input.indexRules }
            : current.customIndexRules
              ? { indexRules: current.indexRules }
              : {}),
        };
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: { diagnosticSettings: stored as Prisma.InputJsonValue },
    });
    await this.engine.recalculate(projectId);
    return this.settings(owner, projectId);
  }

  async recalculate(owner: SeoOwner, projectId: string): Promise<SeoDiagnosticsRecalcDto> {
    await this.projects.resolveProject(owner, projectId);
    const res = await this.engine.recalculate(projectId);
    if (!res) throw this.notFound();
    return res;
  }

  // ------------------------------------------------------- canibalización

  private cannibalWhere(projectId: string, q: SeoDiagnosticListQuery) {
    const statuses = q.statuses?.length ? q.statuses : SEO_DIAGNOSTIC_OPEN_STATUSES;
    return {
      projectId,
      status: { in: statuses },
      OR: [{ active: true }, { status: { in: ['fixed', 'ok'] } }],
      ...(q.severities?.length ? { severity: { in: q.severities } } : {}),
      ...(q.kinds?.length ? { kind: { in: q.kinds } } : {}),
      ...(q.search ? { query: { contains: q.search, mode: 'insensitive' as const } } : {}),
      ...(q.domainId ? { domainId: q.domainId } : {}),
    } satisfies Prisma.SeoCannibalizationWhereInput;
  }

  private cannibalOrder(): Prisma.SeoCannibalizationOrderByWithRelationInput[] {
    // La gravedad no se ordena bien por texto: el orden final (alta, media, baja) se hace al leer.
    return [{ detectedAt: 'desc' }, { id: 'asc' }];
  }

  async cannibalizations(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoDiagnosticListQuery,
  ): Promise<SeoDiagnosticListDto<SeoCannibalizationDto>> {
    const project = await this.projects.resolveProject(owner, projectId);
    const where = this.cannibalWhere(projectId, q);
    const [total, rows] = await Promise.all([
      this.admin.seoCannibalization.count({ where }),
      this.admin.seoCannibalization.findMany({
        where,
        orderBy: this.cannibalOrder(),
        take: LIST_MAX,
      }),
    ]);
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const items = rows
      .map((r) => this.cannibalDto(r))
      .sort(
        (a, b) =>
          (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) ||
          b.totals.impressions - a.totals.impressions,
      );
    return { calculatedAt: iso(project.diagnosticsCalculatedAt), total, items };
  }

  async cannibalizationSummary(
    owner: SeoOwner | undefined,
    projectId: string,
  ): Promise<SeoCannibalizationSummaryDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const open = { projectId, active: true, status: { in: SEO_DIAGNOSTIC_OPEN_STATUSES } };
    const [bySev, byKind, byStatus] = await Promise.all([
      this.admin.seoCannibalization.groupBy({
        by: ['severity'],
        where: open,
        _count: { _all: true },
      }),
      this.admin.seoCannibalization.groupBy({ by: ['kind'], where: open, _count: { _all: true } }),
      this.admin.seoCannibalization.groupBy({
        by: ['status'],
        where: { projectId, OR: [{ active: true }, { status: { in: ['fixed', 'ok'] } }] },
        _count: { _all: true },
      }),
    ]);
    const zero = <K extends string>(keys: readonly K[]) =>
      Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
    const severities = zero(SEO_SEVERITIES);
    for (const r of bySev) severities[r.severity as SeoSeverity] = r._count._all;
    const kinds = zero(SEO_CANNIBALIZATION_KINDS);
    for (const r of byKind) kinds[r.kind as SeoCannibalizationKind] = r._count._all;
    const statuses = zero(SEO_DIAGNOSTIC_STATUSES);
    for (const r of byStatus) statuses[r.status as SeoDiagnosticStatus] = r._count._all;
    return {
      calculatedAt: iso(project.diagnosticsCalculatedAt),
      open: Object.values(severities).reduce((a, b) => a + b, 0),
      bySeverity: severities,
      byKind: kinds,
      byStatus: statuses,
    };
  }

  async updateCannibalization(
    owner: SeoOwner,
    projectId: string,
    id: string,
    input: UpdateSeoDiagnosticInput,
  ): Promise<SeoCannibalizationDto> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.admin.seoCannibalization.findFirst({ where: { id, projectId } });
    if (!row) throw this.notFound();
    const updated = await this.admin.seoCannibalization.update({
      where: { id },
      data: this.statusData(row.status, input),
    });
    return this.cannibalDto(updated);
  }

  async cannibalizationCsv(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoDiagnosticListQuery,
  ): Promise<string> {
    const { items } = await this.cannibalizations(owner, projectId, q);
    const header = [
      'Búsqueda',
      'Dominio',
      'Gravedad',
      'Tipo',
      'Estado',
      'Impresiones',
      'Clics',
      'Páginas',
      'Reparto de impresiones',
      'Cambios de página',
      'URL objetivo',
      'URL propuesta',
      'Desde',
      'Hasta',
      'Motivo',
      'Acción sugerida',
      'Notas',
    ];
    const lines = [header.map(csvCell).join(';')];
    for (const c of items) {
      lines.push(
        [
          csvCell(c.query),
          csvCell(c.domain),
          csvCell(SEO_SEVERITY_LABELS[c.severity]),
          csvCell(SEO_CANNIBALIZATION_KIND_LABELS[c.kind]),
          csvCell(SEO_DIAGNOSTIC_STATUS_LABELS[c.status]),
          csvCell(c.totals.impressions),
          csvCell(c.totals.clicks),
          csvCell(c.pages.map((p) => p.page).join(' | ')),
          csvCell(c.pages.map((p) => `${Math.round(p.impressionsShare * 100)} %`).join(' | ')),
          csvCell(c.switches),
          csvCell(c.targetUrl),
          csvCell(c.suggestedUrl),
          csvCell(c.period.from),
          csvCell(c.period.to),
          csvLineCell(c.reason),
          csvLineCell(c.action),
          csvLineCell(c.notes),
        ].join(';'),
      );
    }
    return CSV_BOM + lines.join('\r\n');
  }

  // --------------------------------------------------------- indexación

  private indexWhere(projectId: string, q: SeoDiagnosticListQuery) {
    const statuses = q.statuses?.length ? q.statuses : SEO_DIAGNOSTIC_OPEN_STATUSES;
    return {
      projectId,
      status: { in: statuses },
      OR: [{ active: true }, { status: { in: ['fixed', 'ok'] } }],
      ...(q.categories?.length ? { category: { in: q.categories } } : {}),
      ...(q.search ? { url: { contains: q.search, mode: 'insensitive' as const } } : {}),
      ...(q.domainId ? { domainId: q.domainId } : {}),
    } satisfies Prisma.SeoIndexFindingWhereInput;
  }

  async indexFindings(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoDiagnosticListQuery,
  ): Promise<SeoDiagnosticListDto<SeoIndexFindingDto>> {
    const project = await this.projects.resolveProject(owner, projectId);
    const where = this.indexWhere(projectId, q);
    const [total, rows] = await Promise.all([
      this.admin.seoIndexFinding.count({ where }),
      this.admin.seoIndexFinding.findMany({
        where,
        orderBy: [{ impressions: 'desc' }, { url: 'asc' }],
        take: LIST_MAX,
      }),
    ]);
    const statuses = await this.technical.indexStatuses(
      projectId,
      rows.map((r) => normalizeSeoUrl(r.url)),
    );
    return {
      calculatedAt: iso(project.diagnosticsCalculatedAt),
      total,
      items: rows.map((r) => this.indexDto(r, statuses.get(normalizeSeoUrl(r.url)) ?? null)),
    };
  }

  async indexSummary(owner: SeoOwner | undefined, projectId: string): Promise<SeoIndexSummaryDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const open = { projectId, active: true, status: { in: SEO_DIAGNOSTIC_OPEN_STATUSES } };
    const [byCat, byStatus] = await Promise.all([
      this.admin.seoIndexFinding.groupBy({ by: ['category'], where: open, _count: { _all: true } }),
      this.admin.seoIndexFinding.groupBy({
        by: ['status'],
        where: { projectId, OR: [{ active: true }, { status: { in: ['fixed', 'ok'] } }] },
        _count: { _all: true },
      }),
    ]);
    const categories = Object.fromEntries(SEO_INDEX_CATEGORIES.map((k) => [k, 0])) as Record<
      SeoIndexCategory,
      number
    >;
    for (const r of byCat) categories[r.category as SeoIndexCategory] = r._count._all;
    const statuses = Object.fromEntries(SEO_DIAGNOSTIC_STATUSES.map((k) => [k, 0])) as Record<
      SeoDiagnosticStatus,
      number
    >;
    for (const r of byStatus) statuses[r.status as SeoDiagnosticStatus] = r._count._all;
    return {
      calculatedAt: iso(project.diagnosticsCalculatedAt),
      open: Object.values(categories).reduce((a, b) => a + b, 0),
      byCategory: categories,
      byStatus: statuses,
    };
  }

  async updateIndexFinding(
    owner: SeoOwner,
    projectId: string,
    id: string,
    input: UpdateSeoDiagnosticInput,
  ): Promise<SeoIndexFindingDto> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.admin.seoIndexFinding.findFirst({ where: { id, projectId } });
    if (!row) throw this.notFound();
    const updated = await this.admin.seoIndexFinding.update({
      where: { id },
      data: this.statusData(row.status, input),
    });
    const key = normalizeSeoUrl(updated.url);
    const statuses = await this.technical.indexStatuses(projectId, [key]);
    return this.indexDto(updated, statuses.get(key) ?? null);
  }

  async indexCsv(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoDiagnosticListQuery,
  ): Promise<string> {
    const { items } = await this.indexFindings(owner, projectId, q);
    const header = [
      'URL',
      'Dominio',
      'Categoría',
      'Regla',
      'Evidencia',
      'Lo que dice Google (inspección)',
      'Impresiones',
      'Clics',
      'Primer día',
      'Último día',
      'Estado',
      'Acción sugerida',
      'Notas',
    ];
    const lines = [header.map(csvCell).join(';')];
    for (const f of items) {
      lines.push(
        [
          csvCell(f.url),
          csvCell(f.domain),
          csvCell(SEO_INDEX_CATEGORY_LABELS[f.category]),
          csvCell(f.rule),
          csvCell(SEO_INDEX_EVIDENCE_LABELS[f.evidence]),
          csvCell(f.inspection?.label ?? 'Sin inspeccionar'),
          csvCell(f.impressions),
          csvCell(f.clicks),
          csvCell(f.firstDate),
          csvCell(f.lastDate),
          csvCell(SEO_DIAGNOSTIC_STATUS_LABELS[f.status]),
          csvLineCell(f.action),
          csvLineCell(f.notes),
        ].join(';'),
      );
    }
    return CSV_BOM + lines.join('\r\n');
  }

  async sitemaps(owner: SeoOwner | undefined, projectId: string): Promise<SeoSitemapsDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const { indexRules } = seoDiagnosticSettingsOf(project.diagnosticSettings);
    return this.engine.sitemaps(project.domains, indexRules);
  }

  // --------------------------------------------------- palabras seguidas

  private domainOf(project: ProjectRow, domainId: string | undefined) {
    const domains = project.domains.filter((d) => d.role !== 'redirect');
    if (domainId) {
      const d = project.domains.find((x) => x.id === domainId);
      if (!d) throw this.notFound();
      return d;
    }
    return domains.find((d) => d.role === 'primary') ?? domains[0] ?? null;
  }

  private async lastDate(domainId: string): Promise<{ first: string | null; last: string | null }> {
    const b = await this.admin.seoGscMetric.aggregate({
      where: { domainId, grain: 'site' },
      _min: { date: true },
      _max: { date: true },
    });
    return { first: dateOnly(b._min.date), last: dateOnly(b._max.date) };
  }

  private async sums(
    domainId: string,
    grain: string,
    keyCol: Prisma.Sql,
    words: string[] | null,
    from: string,
    to: string,
    extra: Prisma.Sql = Prisma.empty,
  ): Promise<SumsRow[]> {
    return this.admin.$queryRaw<SumsRow[]>(Prisma.sql`
      SELECT ${keyCol} AS key, ${SUMS}
      FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = ${grain}
        AND date BETWEEN ${from}::date AND ${to}::date
        ${words ? Prisma.sql`AND query = ANY(${words}::text[])` : Prisma.empty}
        ${extra}
      GROUP BY 1`);
  }

  async trackedKeywords(
    owner: SeoOwner | undefined,
    projectId: string,
    q: { days: number; domainId?: string | undefined },
  ): Promise<SeoTrackedKeywordsDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const domain = this.domainOf(project, q.domainId);
    const catalog = await this.admin.seoProjectKeyword.findMany({
      where: { projectId },
      include: { keyword: true, masterImport: { select: { createdAt: true } } },
      orderBy: [{ isActive: 'desc' }, { priority: 'asc' }, { createdAt: 'asc' }],
    });
    const words = [...new Set(catalog.map((c) => normalizeSeoKeyword(c.keyword.keyword)))];
    const pool = poolOfProject(project);
    const metrics = await this.opportunityEngine.keywordMetrics(
      pool,
      project.country.toLowerCase(),
      words,
    );
    const bounds = domain ? await this.lastDate(domain.id) : { first: null, last: null };
    const range = seoPeriodRange(bounds.last ?? today(), q.days);
    let comparable = false;
    let cur = new Map<string, SumsRow>();
    let prev = new Map<string, SumsRow>();
    const pagesBy = new Map<string, SeoPageMetric[]>();
    if (domain && bounds.last && words.length > 0) {
      const prevDays = await this.admin.seoGscMetric.count({
        where: {
          domainId: domain.id,
          grain: 'site',
          date: {
            gte: new Date(`${range.previousFrom}T00:00:00Z`),
            lte: new Date(`${range.previousTo}T00:00:00Z`),
          },
        },
      });
      comparable = seoPeriodCovered({
        firstDate: bounds.first,
        from: range.previousFrom,
        to: range.previousTo,
        daysWithData: prevDays,
      });
      const [c, p, pages] = await Promise.all([
        this.sums(domain.id, 'query', Prisma.sql`query`, words, range.from, range.to),
        comparable
          ? this.sums(
              domain.id,
              'query',
              Prisma.sql`query`,
              words,
              range.previousFrom,
              range.previousTo,
            )
          : Promise.resolve([]),
        this.admin.$queryRaw<(SumsRow & { page: string })[]>(Prisma.sql`
          SELECT query AS key, page, ${SUMS}
          FROM seo_gsc_metrics
          WHERE domain_id = ${domain.id}::uuid AND grain = 'query_page'
            AND date BETWEEN ${range.from}::date AND ${range.to}::date
            AND query = ANY(${words}::text[]) AND page <> ''
          GROUP BY query, page`),
      ]);
      cur = new Map(c.map((r) => [r.key, r]));
      prev = new Map(p.map((r) => [r.key, r]));
      for (const r of pages) {
        const t = totalsOf(r);
        const list = pagesBy.get(r.key) ?? [];
        list.push({
          page: r.page,
          clicks: t.clicks,
          impressions: t.impressions,
          position: t.position,
        });
        pagesBy.set(r.key, list);
      }
    }
    // Lo que dice Google de cada URL objetivo (su última inspección, PR 9).
    const primaryDomain =
      project.domains.find((d) => d.role === 'primary')?.domain ?? domain?.domain ?? '';
    const targetKey = (u: string) => seoInspectionUrlKey(u, domain?.domain ?? primaryDomain);
    const targetIndex = await this.technical.indexStatuses(
      projectId,
      catalog.flatMap((c) => (c.targetUrl ? [targetKey(c.targetUrl)] : [])),
    );
    const items: SeoTrackedKeywordDto[] = catalog.map((c) => {
      const word = normalizeSeoKeyword(c.keyword.keyword);
      const t = totalsOf(cur.get(word));
      const pr = prev.get(word);
      const previous = pr ? totalsOf(pr) : null;
      const m = metrics.get(word) ?? null;
      const manual = (c.intent as SeoKeywordIntent | null) ?? null;
      const intent = seoTrackedIntent({ manual, sistrix: m?.intent ?? null, keyword: word });
      const target = seoTargetStatus({ targetUrl: c.targetUrl, pages: pagesBy.get(word) ?? [] });
      return {
        id: c.id,
        keyword: c.keyword.keyword,
        groupName: c.groupName,
        intent: intent?.value ?? null,
        intentSource: intent?.source ?? null,
        manualIntent: manual,
        targetUrl: c.targetUrl,
        priority: c.priority,
        notes: c.notes,
        strategyLocked: c.strategyLocked,
        source: c.source as SeoKeywordSource,
        isActive: c.isActive,
        createdAt: c.createdAt.toISOString(),
        masterImportedAt: c.masterImport?.createdAt.toISOString() ?? null,
        clicks: t.clicks,
        impressions: t.impressions,
        ctr: t.ctr,
        position: t.position,
        previousPosition: previous?.position ?? null,
        positionDiff:
          comparable && t.position !== null && previous?.position != null
            ? Math.round((previous.position - t.position) * 10) / 10
            : null,
        googlePage: target.topPage,
        targetStatus: target.status,
        targetShare: target.targetShare,
        topShare: target.topShare,
        suggestedUrl: target.suggestedUrl,
        volume: m?.volume ?? null,
        volumeOrigin: m ? m.origin : null,
        targetIndex: c.targetUrl ? (targetIndex.get(targetKey(c.targetUrl)) ?? null) : null,
      };
    });
    const labels = { intent: SEO_KEYWORD_INTENT_LABELS, none: 'Sin decidir' };
    const targetSummary = Object.fromEntries(SEO_TARGET_STATUSES.map((s) => [s, 0])) as Record<
      SeoTargetStatus,
      number
    >;
    for (const k of items) targetSummary[k.targetStatus] += 1;
    return {
      domainId: domain?.id ?? null,
      domain: domain?.domain ?? null,
      days: q.days,
      lastDate: bounds.last,
      ...range,
      comparable,
      items,
      byIntent: seoGroupTrackedKeywords(items, 'intent', labels),
      byGroup: seoGroupTrackedKeywords(items, 'group', { ...labels, none: 'Sin grupo' }),
      targetSummary,
      count: catalog.length,
      limit: this.sistrix.limits(project).keywords,
    };
  }

  async trackedKeywordsCsv(
    owner: SeoOwner | undefined,
    projectId: string,
    q: { days: number; domainId?: string | undefined },
  ): Promise<string> {
    const data = await this.trackedKeywords(owner, projectId, q);
    const header = [
      'Palabra',
      'Grupo',
      'Intención',
      'Prioridad',
      'Posición',
      'Variación (puestos)',
      'Clics',
      'Impresiones',
      'CTR (%)',
      'URL objetivo',
      'Página que enseña Google',
      'Estado de la URL objetivo',
      'URL propuesta',
      'Indexación de la URL objetivo (Google)',
      'Volumen SISTRIX (estimación)',
      'Origen',
      'Notas',
    ];
    const lines = [header.map(csvCell).join(';')];
    for (const k of data.items) {
      lines.push(
        [
          csvCell(k.keyword),
          csvCell(k.groupName),
          csvCell(k.intent ? SEO_KEYWORD_INTENT_LABELS[k.intent] : null),
          csvCell(SEO_KEYWORD_PRIORITY_LABELS[k.priority] ?? String(k.priority)),
          csvCell(k.position),
          csvCell(k.positionDiff),
          csvCell(k.clicks),
          csvCell(k.impressions),
          csvCell(k.ctr !== null ? Math.round(k.ctr * 1000) / 10 : null),
          csvCell(k.targetUrl),
          csvCell(k.googlePage),
          csvCell(SEO_TARGET_STATUS_LABELS[k.targetStatus]),
          csvCell(k.suggestedUrl),
          csvCell(k.targetIndex?.label ?? null),
          csvCell(k.volume),
          csvCell(SEO_KEYWORD_SOURCE_LABELS[k.source] ?? k.source),
          csvLineCell(k.notes),
        ].join(';'),
      );
    }
    return CSV_BOM + lines.join('\r\n');
  }

  async trackedKeyword(
    owner: SeoOwner | undefined,
    projectId: string,
    keywordId: string,
    q: { days?: number | undefined; domainId?: string | undefined },
  ): Promise<SeoTrackedKeywordDetailDto> {
    const days = q.days && isSeoTrackedPeriod(q.days) ? q.days : DETAIL_DAYS;
    const list = await this.trackedKeywords(owner, projectId, { days, domainId: q.domainId });
    const keyword = list.items.find((k) => k.id === keywordId);
    if (!keyword) throw this.notFound();
    const project = await this.projects.resolveProject(owner, projectId);
    const word = normalizeSeoKeyword(keyword.keyword);
    const out: SeoTrackedKeywordDetailDto = {
      keyword,
      domain: list.domain,
      from: list.from,
      to: list.to,
      daily: [],
      pageChanges: [],
      pages: [],
      devices: [],
      countries: [],
      sistrix: await this.sistrixSeries(project, keywordId, word),
    };
    if (!list.domainId || !list.lastDate) return out;
    const domainId = list.domainId;
    const [days_, perPage, devices, countries] = await Promise.all([
      this.sums(domainId, 'query', Prisma.sql`date::text`, [word], list.from, list.to),
      this.admin.$queryRaw<{ date: Date; page: string; c: number; i: number }[]>(Prisma.sql`
        SELECT date, page, SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i
        FROM seo_gsc_metrics
        WHERE domain_id = ${domainId}::uuid AND grain = 'query_page' AND query = ${word}
          AND date BETWEEN ${list.from}::date AND ${list.to}::date
        GROUP BY date, page`),
      this.sums(domainId, 'query_device', Prisma.sql`device`, [word], list.from, list.to),
      this.sums(domainId, 'query_country', Prisma.sql`country`, [word], list.from, list.to),
    ]);
    const daily = perPage.map((r) => ({
      date: dateOnly(new Date(r.date))!,
      page: r.page,
      clicks: Number(r.c),
      impressions: Number(r.i),
    }));
    const winners = seoDailyWinners(daily);
    const winnerBy = new Map(winners.map((w) => [w.date, w.page]));
    const byDate = new Map(days_.map((r) => [r.key, r]));
    for (let d = list.from; d <= list.to; d = shiftDate(d, 1)) {
      const t = byDate.get(d);
      const tot = totalsOf(t);
      out.daily.push({
        date: d,
        clicks: tot.clicks,
        impressions: tot.impressions,
        ctr: tot.ctr,
        position: t ? tot.position : null,
        page: winnerBy.get(d) ?? null,
      });
    }
    if (out.daily.every((x) => x.impressions === 0 && x.clicks === 0)) out.daily = [];
    out.pageChanges = seoPageChanges(winners);
    const pageTotals = new Map<string, SeoPageMetric>();
    for (const r of daily) {
      const p = pageTotals.get(r.page) ?? {
        page: r.page,
        clicks: 0,
        impressions: 0,
        position: null,
      };
      p.clicks += r.clicks;
      p.impressions += r.impressions;
      pageTotals.set(r.page, p);
    }
    const pageSums = await this.admin.$queryRaw<(SumsRow & { page: string })[]>(Prisma.sql`
      SELECT page AS key, page, ${SUMS} FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = 'query_page' AND query = ${word}
        AND date BETWEEN ${list.from}::date AND ${list.to}::date
      GROUP BY page`);
    const totalImpr = pageSums.reduce((n, r) => n + Number(r.i), 0);
    const targetKey = keyword.targetUrl ? normalizeSeoUrl(keyword.targetUrl) : null;
    out.pages = pageSums
      .map((r) => {
        const t = totalsOf(r);
        return {
          page: r.page,
          clicks: t.clicks,
          impressions: t.impressions,
          position: t.position,
          ctr: t.ctr,
          share: totalImpr > 0 ? round3(t.impressions / totalImpr) : 0,
          isTarget: !!targetKey && normalizeSeoUrl(r.page) === targetKey,
        };
      })
      .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
    const toRows = <K extends string>(rows: SumsRow[], name: K) =>
      rows
        .map((r) => {
          const t = totalsOf(r);
          return {
            [name]: r.key,
            clicks: t.clicks,
            impressions: t.impressions,
            ctr: t.ctr,
            position: t.position,
          } as Record<K, string> & {
            clicks: number;
            impressions: number;
            ctr: number | null;
            position: number | null;
          };
        })
        .sort((a, b) => b.impressions - a.impressions);
    out.devices = toRows(devices, 'device');
    out.countries = toRows(countries, 'country').slice(0, 10);
    return out;
  }

  /** Posición estimada de SISTRIX de tus dominios para esta palabra (serie aparte). */
  private async sistrixSeries(
    project: ProjectRow,
    projectKeywordId: string,
    word: string,
  ): Promise<SeoTrackedKeywordDetailDto['sistrix']> {
    const pool = poolOfProject(project);
    const own = project.domains.map((d) => d.domain);
    const ownWww = [...own, ...own.map((d) => `www.${d}`)];
    const row = await this.admin.seoProjectKeyword.findUnique({
      where: { id: projectKeywordId },
      select: { keywordId: true },
    });
    const country = project.country.toLowerCase();
    const [serps, domainKw] = await Promise.all([
      row
        ? this.admin.seoSerpResult.findMany({
            where: { tenantId: pool, keywordId: row.keywordId, domain: { in: ownWww } },
            orderBy: [{ sampleDate: 'asc' }, { position: 'asc' }],
            take: 500,
          })
        : Promise.resolve([]),
      this.admin.seoDomainKeyword.findMany({
        where: {
          tenantId: pool,
          country,
          domain: { in: ownWww },
          keyword: { equals: word, mode: 'insensitive' },
        },
        orderBy: [{ sampleDate: 'asc' }, { position: 'asc' }],
        take: 500,
      }),
    ]);
    const byDate = new Map<
      string,
      { date: string; position: number; url: string; provider: SeoProviderKey; fetchedAt: Date }
    >();
    for (const r of [...domainKw, ...serps]) {
      const date = dateOnly(r.sampleDate)!;
      const prev = byDate.get(date);
      if (!prev || r.position < prev.position) {
        byDate.set(date, {
          date,
          position: r.position,
          url: r.url,
          provider: r.provider as SeoProviderKey,
          fetchedAt: r.fetchedAt,
        });
      }
    }
    const points = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = points[points.length - 1];
    const origin: SeoDataOriginDto | null = last
      ? { provider: last.provider, fetchedAt: last.fetchedAt.toISOString(), dataDate: last.date }
      : null;
    return {
      points: points.map(({ fetchedAt: _f, ...p }) => p),
      origin,
    };
  }

  // ------------------------------------------- alta desde Search Console

  async keywordCandidates(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoCandidateQuery,
  ): Promise<SeoKeywordCandidatesDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const domain = this.domainOf(project, q.domainId);
    const bounds = domain ? await this.lastDate(domain.id) : { first: null, last: null };
    const range = seoPeriodRange(bounds.last ?? today(), q.days);
    if (!domain || !bounds.last) {
      return {
        domain: domain?.domain ?? null,
        from: range.from,
        to: range.to,
        items: [],
        total: 0,
      };
    }
    const rows = await this.admin.$queryRaw<SumsRow[]>(Prisma.sql`
      SELECT query AS key, ${SUMS}
      FROM seo_gsc_metrics
      WHERE domain_id = ${domain.id}::uuid AND grain = 'query' AND query <> ''
        AND date BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY query
      HAVING SUM(impressions) >= ${q.minImpressions}
      ORDER BY SUM(impressions) DESC, query ASC
      LIMIT ${CANDIDATE_SCAN}`);
    const tracked = new Set(
      (
        await this.admin.seoProjectKeyword.findMany({
          where: { projectId },
          select: { keyword: { select: { keyword: true } } },
        })
      ).map((r) => normalizeSeoKeyword(r.keyword.keyword)),
    );
    const search = q.search ? normalizeSeoKeyword(q.search) : null;
    const filtered = rows
      .map((r) => {
        const t = totalsOf(r);
        const query = r.key;
        return {
          query,
          clicks: t.clicks,
          impressions: t.impressions,
          ctr: t.ctr,
          position: t.position,
          brand: isBrandQuery(query, project.brandTerms),
          tracked: tracked.has(normalizeSeoKeyword(query)),
          intent: seoRuleIntent(query),
        };
      })
      .filter(
        (c) =>
          (!q.excludeBrand || !c.brand) &&
          (!q.excludeTracked || !c.tracked) &&
          (q.minPosition === undefined || (c.position ?? 0) >= q.minPosition) &&
          (q.maxPosition === undefined || (c.position ?? Infinity) <= q.maxPosition) &&
          (!search || normalizeSeoKeyword(c.query).includes(search)),
      );
    return {
      domain: domain.domain,
      from: range.from,
      to: range.to,
      items: filtered.slice(0, SEO_KEYWORD_CANDIDATES_MAX),
      total: filtered.length,
    };
  }

  // ------------------------------------------------- alta desde CSV/Excel

  private async readImport(input: SeoKeywordImportInput) {
    let csv: string;
    try {
      csv = await resolveImportCsv(input.content, input.format);
    } catch {
      throw new BadRequestException({
        code: 'seo_import_unreadable',
        message: 'No se ha podido leer el fichero. Usa un CSV o un Excel (.xlsx).',
      });
    }
    const { columns, records } = parseRaw(csv);
    const mapped = columns.map((name) => ({
      name,
      field: (SEO_KEYWORD_IMPORT_ALIASES[normalizeSeoImportHeader(name)] ??
        null) as SeoKeywordImportField | null,
    }));
    if (!mapped.some((c) => c.field === 'keyword')) {
      throw new BadRequestException({
        code: 'seo_import_no_keyword_column',
        message: 'Falta la columna con las palabras (llámala «palabra» o «keyword»).',
      });
    }
    if (records.length > IMPORT_MAX_ROWS) {
      throw new BadRequestException({
        code: 'seo_import_too_many_rows',
        message: `El fichero tiene ${records.length} filas; como mucho ${IMPORT_MAX_ROWS}.`,
      });
    }
    const rows: SeoKeywordImportInputRow[] = records.map((rec, k) => {
      const row: SeoKeywordImportInputRow = { line: k + 2 };
      for (const c of mapped) {
        // Si hay dos columnas para el mismo campo, vale la primera con valor.
        if (c.field && !row[c.field] && rec[c.name]?.trim()) row[c.field] = rec[c.name];
      }
      return row;
    });
    return { columns: mapped, rows };
  }

  private async importPlan(owner: SeoOwner, projectId: string, input: SeoKeywordImportInput) {
    const p = await this.sistrix.project(owner, projectId);
    const { columns, rows } = await this.readImport(input);
    const catalog = await this.admin.seoProjectKeyword.findMany({
      where: { projectId },
      include: { keyword: { select: { keyword: true } } },
    });
    const existing = new Map<string, SeoKeywordImportExisting & { keywordId: string }>(
      catalog.map((c) => [
        normalizeSeoKeyword(c.keyword.keyword),
        {
          keywordId: c.keywordId,
          groupName: c.groupName,
          intent: (c.intent as SeoKeywordIntent | null) ?? null,
          targetUrl: c.targetUrl,
          notes: c.notes,
          strategyLocked: c.strategyLocked,
        },
      ]),
    );
    const plan = planSeoKeywordImport({ rows, existing });
    const limit = this.sistrix.limits(p).keywords;
    return { project: p, columns, plan, existing, current: catalog.length, limit };
  }

  async importPreview(
    owner: SeoOwner,
    projectId: string,
    input: SeoKeywordImportInput,
  ): Promise<SeoKeywordImportPreviewDto> {
    const { columns, plan, current, limit } = await this.importPlan(owner, projectId, input);
    return {
      items: plan.items,
      counts: plan.counts,
      columns,
      current,
      limit,
      overLimit: current + plan.counts.create > limit,
    };
  }

  /**
   * Importa: crea las nuevas y en las demás rellena solo lo vacío. Cada campo
   * se escribe con la condición de que siga vacío y la palabra no esté fijada,
   * así que ni una edición a la vez se pisa.
   */
  async importCommit(
    owner: SeoOwner,
    projectId: string,
    input: SeoKeywordImportInput,
  ): Promise<SeoKeywordImportResultDto> {
    const { project, plan, existing, current, limit } = await this.importPlan(
      owner,
      projectId,
      input,
    );
    const creates = plan.items.filter((i) => i.action === 'create');
    if (current + creates.length > limit) {
      throw new ConflictException({
        code: 'seo_keyword_limit',
        message: `Puedes tener ${limit} palabras como mucho (llevas ${current} y el fichero trae ${creates.length} nuevas).`,
      });
    }
    const country = project.country.toUpperCase();
    const language = project.language.toLowerCase();
    let created = 0;
    let updated = 0;
    await this.admin.$transaction(
      async (tx) => {
        if (creates.length > 0) {
          await tx.seoKeyword.createMany({
            data: creates.map((c) => ({ keyword: c.keyword, country, language })),
            skipDuplicates: true,
          });
          const ids = await tx.seoKeyword.findMany({
            where: { keyword: { in: creates.map((c) => c.keyword) }, country, language },
            select: { id: true, keyword: true },
          });
          const idOf = new Map(ids.map((r) => [r.keyword, r.id]));
          const res = await tx.seoProjectKeyword.createMany({
            data: creates.flatMap((c) => {
              const keywordId = idOf.get(c.keyword);
              return keywordId
                ? [
                    {
                      tenantId: project.tenantId,
                      projectId,
                      keywordId,
                      groupName: c.data.groupName,
                      intent: c.data.intent,
                      targetUrl: c.data.targetUrl,
                      priority: c.data.priority ?? 2,
                      notes: c.data.notes,
                      source: 'import',
                    },
                  ]
                : [];
            }),
            skipDuplicates: true,
          });
          created = res.count;
        }
        for (const item of plan.items.filter((i) => i.action === 'update')) {
          const prev = existing.get(item.keyword);
          if (!prev) continue;
          let touched = false;
          for (const field of item.changes) {
            const res = await tx.seoProjectKeyword.updateMany({
              where: { projectId, keywordId: prev.keywordId, strategyLocked: false, [field]: null },
              data: { [field]: item.data[field] },
            });
            touched ||= res.count > 0;
          }
          if (touched) updated += 1;
        }
      },
      { timeout: 60_000 },
    );
    return {
      created,
      updated,
      unchanged: plan.counts.unchanged,
      locked: plan.counts.locked,
      errors: plan.counts.error,
    };
  }

  // ---------------------------------------------------------------- comunes

  private statusData(
    current: string,
    input: UpdateSeoDiagnosticInput,
  ): Prisma.SeoCannibalizationUpdateInput & Prisma.SeoIndexFindingUpdateInput {
    const data: Prisma.SeoCannibalizationUpdateInput & Prisma.SeoIndexFindingUpdateInput = {};
    if (input.status !== undefined && input.status !== current) {
      data.status = input.status;
      if (input.status === 'fixed' || input.status === 'ok') data.resolvedAt = new Date();
      else {
        data.resolvedAt = null;
        data.returnedAt = null;
      }
    }
    if (input.notes !== undefined) data.notes = input.notes || null;
    return data;
  }

  private base(r: {
    id: string;
    projectId: string;
    domain: string;
    status: string;
    notes: string | null;
    active: boolean;
    returnedAt: Date | null;
    detectedAt: Date;
    lastSeenAt: Date;
    resolvedAt: Date | null;
    updatedAt: Date;
  }) {
    return {
      id: r.id,
      projectId: r.projectId,
      domain: r.domain,
      status: r.status as SeoDiagnosticStatus,
      notes: r.notes,
      active: r.active,
      returnedAt: iso(r.returnedAt),
      detectedAt: r.detectedAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      resolvedAt: iso(r.resolvedAt),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private cannibalDto(r: Prisma.SeoCannibalizationGetPayload<object>): SeoCannibalizationDto {
    return {
      ...this.base(r),
      query: r.query,
      severity: r.severity as SeoSeverity,
      kind: r.kind as SeoCannibalizationKind,
      expected: r.expected,
      pages: r.pages as unknown as SeoCannibalizationPageDto[],
      timeline: r.timeline as unknown as { date: string; page: string }[],
      switches: r.switches,
      targetUrl: r.targetUrl,
      suggestedUrl: r.suggestedUrl,
      totals: r.totals as unknown as SeoCannibalizationDto['totals'],
      period: { from: dateOnly(r.periodFrom)!, to: dateOnly(r.periodTo)! },
      lastDataDate: dateOnly(r.lastDataDate),
      reason: r.reason,
      action: r.action,
    };
  }

  private indexDto(
    r: Prisma.SeoIndexFindingGetPayload<object>,
    inspection: SeoUrlIndexStatusDto | null = null,
  ): SeoIndexFindingDto {
    return {
      ...this.base(r),
      url: r.url,
      category: r.category as SeoIndexCategory,
      rule: r.rule,
      clicks: r.clicks,
      impressions: r.impressions,
      firstDate: dateOnly(r.firstDate)!,
      lastDate: dateOnly(r.lastDate)!,
      evidence: r.evidence === 'inspection' ? 'inspection' : 'performance',
      reason: r.reason,
      action: r.action,
      inspection,
    };
  }
}

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';
import {
  SEO_OPPORTUNITY_OPEN_STATUSES,
  SEO_PLATFORM_CONVERSION_TYPES,
  SEO_PRIMARY_CONVERSION_TYPES,
  SEO_REPORT_KIND_LABELS,
  SEO_TASK_OPEN_STATUSES,
  SEO_TENANT_CONVERSION_TYPES,
  renderAdminEmail,
  seoChange,
  seoConversionRate,
  seoPeriodCovered,
  seoReportHighlights,
  seoReportPeriod,
  seoReportSettingsOf,
  seoTotalsFromSums,
  type SeoAlertSeverity,
  type SeoAlertType,
  type SeoConversionType,
  type SeoReportContentDto,
  type SeoReportTechnicalDto,
  type SeoReportDto,
  type SeoReportKeywordMoveDto,
  type SeoReportKind,
  type SeoReportPeriod,
  type SeoReportSettings,
  type SeoReportStatus,
  type SeoReportsDto,
  type UpdateSeoReportSettingsInput,
} from '@storageos/shared';

import { todayInTimezone } from '../../../common/format';
import { loadPuppeteer } from '../../../common/puppeteer';
import { escapeHtml, safeBrandColor, tenantEmailShell } from '../../../common/tenant-email-layout';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { EmailService } from '../../email/email.service';
import { FilesService } from '../../files/files.service';
import { SeoSiteChangesService } from '../plan/seo-site-changes.service';
import { SeoProjectsService, type ProjectRow, type SeoOwner } from '../seo-projects.service';
import { poolOfProject } from '../sistrix/sistrix-sync.service';

import { SeoConversionsService } from './seo-conversions.service';
import { seoProjectEligible } from './seo-eligible';
import { activeSuperAdmins, tenantUsersWithPermission, type SeoRecipient } from './seo-recipients';
import { renderSeoReportHtml, testSeoReportPdf } from './seo-report-template';

import type { Env } from '../../../config/env.schema';

type ReportRow = Prisma.SeoReportGetPayload<object>;

const today = () => todayInTimezone().toISOString().slice(0, 10);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** El enlace al PDF del correo vale 7 días (lo máximo de una URL firmada); en el panel se pide otro. */
const PDF_LINK_SECONDS = 7 * 86_400;
const PLATFORM_COLOR = '#2563eb';

interface Sums {
  c: number | null;
  i: number | null;
  w: number | null;
  ps: number | null;
  n: number | null;
}

/**
 * Informes semanal y mensual de un proyecto SEO (PR 8): cifras del periodo
 * frente al anterior, lo que trae Google, visibilidad, palabras que suben y
 * bajan, oportunidades, diagnóstico, actuaciones con resultado, tareas y
 * alertas. Se envían por correo (enlace firmado al PDF, guardado en el
 * bucket privado `reports`) y quedan en el historial (`seo_reports`).
 *
 * El correo lleva un enlace al PDF y no el PDF adjunto: el envío de correo
 * de la app no admite adjuntos (ni el proveedor SMTP, ni Brevo, ni Resend en
 * su forma actual, ni la cola `email`, que guarda el cuerpo en Redis).
 */
@Injectable()
export class SeoReportsService {
  private readonly logger = new Logger(SeoReportsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly conversions: SeoConversionsService,
    private readonly changes: SeoSiteChangesService,
    private readonly files: FilesService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private notFound() {
    return new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
  }

  private web() {
    return this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
  }

  private panelLink(project: { id: string; tenantId: string | null }) {
    return project.tenantId ? '/seo-advanced#informes' : `/admin/seo/${project.id}#informes`;
  }

  // -------------------------------------------------------------- ajustes

  private async candidates(project: { tenantId: string | null }): Promise<SeoRecipient[]> {
    return project.tenantId
      ? tenantUsersWithPermission(this.admin, project.tenantId, 'settings:manage')
      : activeSuperAdmins(this.admin);
  }

  async overview(owner: SeoOwner | undefined, projectId: string): Promise<SeoReportsDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const [rows, candidates] = await Promise.all([
      this.admin.seoReport.findMany({
        where: { projectId },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 50,
      }),
      this.candidates(project),
    ]);
    return {
      settings: seoReportSettingsOf(project.reportSettings),
      items: rows.map((r) => this.toDto(r)),
      candidates,
    };
  }

  async updateSettings(
    owner: SeoOwner,
    projectId: string,
    input: UpdateSeoReportSettingsInput,
  ): Promise<SeoReportSettings> {
    const project = await this.projects.resolveProject(owner, projectId);
    const current = seoReportSettingsOf(project.reportSettings);
    if (input.recipientIds) {
      const allowed = new Set((await this.candidates(project)).map((c) => c.id));
      if (input.recipientIds.some((id) => !allowed.has(id))) {
        throw new BadRequestException({
          code: 'seo_report_recipient_invalid',
          message: 'Solo puede recibirlo quien gestiona la configuración.',
        });
      }
    }
    const next = seoReportSettingsOf({
      ...current,
      ...(input.weekly !== undefined ? { weekly: input.weekly } : {}),
      ...(input.monthly !== undefined ? { monthly: input.monthly } : {}),
      ...(input.recipientIds ? { recipientIds: input.recipientIds } : {}),
      // Los correos de fuera solo en la plataforma (los de un negocio son su equipo).
      ...(input.extraEmails && !project.tenantId ? { extraEmails: input.extraEmails } : {}),
    });
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: { reportSettings: next as unknown as Prisma.InputJsonValue },
    });
    return next;
  }

  private toDto(r: ReportRow): SeoReportDto {
    return {
      id: r.id,
      kind: r.kind as SeoReportKind,
      periodFrom: dateOnly(r.periodFrom)!,
      periodTo: dateOnly(r.periodTo)!,
      periodKey: r.periodKey,
      status: r.status as SeoReportStatus,
      trigger: r.trigger === 'manual' ? 'manual' : 'cron',
      recipients: r.recipients,
      hasPdf: !!r.pdfKey,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
    };
  }

  /** URL firmada (5 minutos) del PDF de un informe enviado. */
  async pdfUrl(owner: SeoOwner | undefined, projectId: string, reportId: string) {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.admin.seoReport.findFirst({ where: { id: reportId, projectId } });
    if (!row?.pdfKey) throw this.notFound();
    return {
      url: await this.files.getPresignedGetUrl(
        'reports',
        row.pdfKey,
        300,
        `informe-seo-${row.periodKey}.pdf`,
      ),
    };
  }

  // ------------------------------------------------------------ contenido

  /** «Ver el informe»: el contenido del último periodo cerrado, sin enviarlo. */
  async preview(
    owner: SeoOwner | undefined,
    projectId: string,
    kind: SeoReportKind,
  ): Promise<SeoReportContentDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    return this.build(project, seoReportPeriod(kind, today()));
  }

  private async sums(domainIds: string[], grain: string, from: string, to: string) {
    if (domainIds.length === 0)
      return seoTotalsFromSums({
        clicks: 0,
        impressions: 0,
        weightedPosition: 0,
        positionSum: 0,
        rows: 0,
      });
    const [r] = await this.admin.$queryRaw<Sums[]>(Prisma.sql`
      SELECT SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
             SUM(position * impressions)::float8 AS w, SUM(position)::float8 AS ps,
             COUNT(*)::float8 AS n
      FROM seo_gsc_metrics
      WHERE domain_id = ANY(${domainIds}::uuid[]) AND grain = ${grain}
        AND date BETWEEN ${from}::date AND ${to}::date`);
    return seoTotalsFromSums({
      clicks: Number(r?.c ?? 0),
      impressions: Number(r?.i ?? 0),
      weightedPosition: Number(r?.w ?? 0),
      positionSum: Number(r?.ps ?? 0),
      rows: Number(r?.n ?? 0),
    });
  }

  async build(project: ProjectRow, period: SeoReportPeriod): Promise<SeoReportContentDto> {
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0] ?? null;
    const ids = primary ? [primary.id] : [];
    const bounds = primary
      ? await this.admin.seoGscMetric.aggregate({
          where: { domainId: primary.id, grain: 'site' },
          _min: { date: true },
        })
      : null;
    const first = dateOnly(bounds?._min.date);
    const days = (from: string, to: string) =>
      primary
        ? this.admin.seoGscMetric.count({
            where: {
              domainId: primary.id,
              grain: 'site',
              date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
            },
          })
        : Promise.resolve(0);
    const [totals, prevTotals, curDays, prevDays] = await Promise.all([
      this.sums(ids, 'site', period.from, period.to),
      this.sums(ids, 'site', period.previousFrom, period.previousTo),
      days(period.from, period.to),
      days(period.previousFrom, period.previousTo),
    ]);
    const complete = seoPeriodCovered({
      firstDate: first,
      from: period.from,
      to: period.to,
      daysWithData: curDays,
    });
    const comparable =
      complete &&
      seoPeriodCovered({
        firstDate: first,
        from: period.previousFrom,
        to: period.previousTo,
        daysWithData: prevDays,
      });

    // Lo que trae Google (de `seo_conversions_daily`).
    const scope = this.conversions.scopeOf(project);
    const types: SeoConversionType[] =
      scope === 'platform'
        ? SEO_PLATFORM_CONVERSION_TYPES
        : scope === 'tenant'
          ? SEO_TENANT_CONVERSION_TYPES
          : [];
    const convRows = async (from: string, to: string) =>
      this.admin.seoConversionDaily.groupBy({
        by: ['type'],
        where: {
          projectId: project.id,
          date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        },
        _sum: { count: true, revenue: true },
      });
    const [convCur, convPrev] = await Promise.all([
      convRows(period.from, period.to),
      convRows(period.previousFrom, period.previousTo),
    ]);
    const countOf = (rows: typeof convCur, t: string) =>
      rows.find((r) => r.type === t)?._sum.count ?? 0;
    const items = types.map((type) => ({
      type,
      count: countOf(convCur, type),
      previous: comparable ? countOf(convPrev, type) : null,
    }));
    const revenues = convCur
      .map((r) => (r._sum.revenue === null ? null : Number(r._sum.revenue)))
      .filter((n): n is number => n !== null);
    const primaryCount = items
      .filter((i) => SEO_PRIMARY_CONVERSION_TYPES.includes(i.type))
      .reduce((s, i) => s + i.count, 0);
    const allIds = project.domains.map((d) => d.id);
    const allClicks = (await this.sums(allIds, 'site', period.from, period.to)).clicks;

    const [visibility, moves, opportunities, cannibalOpen, cannibals, indexOpen, tasks, alerts] =
      await Promise.all([
        this.visibility(project, primary?.domain ?? null, period),
        primary ? this.keywordMoves(project.id, primary.id, period) : Promise.resolve(null),
        this.admin.seoOpportunity.findMany({
          where: {
            projectId: project.id,
            active: true,
            status: { in: SEO_OPPORTUNITY_OPEN_STATUSES },
            detectedAt: {
              gte: new Date(`${period.from}T00:00:00Z`),
              lt: new Date(`${period.to}T23:59:59.999Z`),
            },
          },
          orderBy: [{ score: 'desc' }, { id: 'asc' }],
          take: 5,
          select: { query: true, type: true, score: true },
        }),
        this.admin.seoCannibalization.count({
          where: { projectId: project.id, active: true, status: { in: ['new', 'reviewed'] } },
        }),
        this.admin.seoCannibalization.findMany({
          where: { projectId: project.id, active: true, status: { in: ['new', 'reviewed'] } },
          orderBy: [{ severity: 'asc' }, { lastSeenAt: 'desc' }],
          take: 5,
          select: { query: true, severity: true },
        }),
        this.admin.seoIndexFinding.count({
          where: { projectId: project.id, active: true, status: { in: ['new', 'reviewed'] } },
        }),
        Promise.all([
          this.admin.seoTask.count({
            where: {
              projectId: project.id,
              status: 'done',
              completedAt: {
                gte: new Date(`${period.from}T00:00:00Z`),
                lt: new Date(`${period.to}T23:59:59.999Z`),
              },
            },
          }),
          this.admin.seoTask.count({
            where: {
              projectId: project.id,
              status: { in: SEO_TASK_OPEN_STATUSES },
              OR: [
                { dueDate: { lt: todayInTimezone() } },
                { dueDate: null, publishDate: { lt: todayInTimezone() } },
              ],
            },
          }),
        ]),
        this.admin.seoAlert.findMany({
          where: {
            projectId: project.id,
            firstSeenAt: { lt: new Date(`${period.to}T23:59:59.999Z`) },
            OR: [
              { status: { in: ['open', 'silenced'] } },
              { resolvedAt: { gte: new Date(`${period.from}T00:00:00Z`) } },
            ],
          },
          orderBy: [{ lastSeenAt: 'desc' }],
          take: 20,
          select: { type: true, severity: true, title: true, status: true },
        }),
      ]);

    const changesWithResult = await this.changesWithResult(project, period);
    const technical = await this.technicalSummary(project.id, period);

    const content: Omit<SeoReportContentDto, 'highlights'> = {
      period,
      project: {
        id: project.id,
        name: project.name,
        tenantId: project.tenantId,
        domain: primary?.domain ?? null,
      },
      complete,
      comparable,
      totals,
      previous: comparable ? prevTotals : null,
      change: comparable ? seoChange(totals, prevTotals) : null,
      conversions: {
        scope,
        items,
        revenue: revenues.length
          ? Math.round(revenues.reduce((s, n) => s + n, 0) * 100) / 100
          : null,
        rate: complete ? seoConversionRate(primaryCount, allClicks) : null,
      },
      visibility,
      keywordsUp: moves?.up ?? [],
      keywordsDown: moves?.down ?? [],
      opportunities,
      cannibalizationsOpen: cannibalOpen,
      cannibalizations: cannibals,
      indexFindingsOpen: indexOpen,
      changesWithResult,
      tasksDone: tasks[0],
      tasksOverdue: tasks[1],
      alerts: alerts.map((a) => ({
        type: a.type as SeoAlertType,
        severity: a.severity as SeoAlertSeverity,
        title: a.title,
        status: a.status,
      })),
      technical,
    };
    return { ...content, highlights: seoReportHighlights(content) };
  }

  /** Inspección de URL y PageSpeed del periodo (la última de cada URL en el periodo). */
  private async technicalSummary(
    projectId: string,
    period: { from: string; to: string },
  ): Promise<SeoReportTechnicalDto | null> {
    const from = new Date(`${period.from}T00:00:00Z`);
    const to = new Date(`${period.to}T23:59:59.999Z`);
    const [insp] = await this.admin.$queryRaw<
      { n: number; ok: number; no: number; canon: number }[]
    >(Prisma.sql`
      SELECT COUNT(*)::float8 AS n,
        COUNT(*) FILTER (WHERE indexed)::float8 AS ok,
        COUNT(*) FILTER (WHERE indexed = false)::float8 AS no,
        COUNT(*) FILTER (WHERE canonical_mismatch)::float8 AS canon
      FROM (
        SELECT DISTINCT ON (url_key) indexed, canonical_mismatch FROM seo_url_inspections
        WHERE project_id = ${projectId}::uuid AND status = 'done'
          AND inspected_at BETWEEN ${from} AND ${to}
        ORDER BY url_key, inspected_at DESC
      ) t`);
    const [psi] = await this.admin.$queryRaw<{ n: number; slow: number; avg: number | null }[]>(
      Prisma.sql`
      SELECT COUNT(*)::float8 AS n,
        COUNT(*) FILTER (WHERE field_overall = 'SLOW' OR performance_score < 50)::float8 AS slow,
        AVG(performance_score)::float8 AS avg
      FROM (
        SELECT DISTINCT ON (url_key) field_overall, performance_score FROM seo_pagespeed_runs
        WHERE project_id = ${projectId}::uuid AND status = 'done' AND strategy = 'mobile'
          AND analyzed_at BETWEEN ${from} AND ${to}
        ORDER BY url_key, analyzed_at DESC
      ) t`,
    );
    const inspected = Number(insp?.n ?? 0);
    const pagespeedUrls = Number(psi?.n ?? 0);
    if (inspected === 0 && pagespeedUrls === 0) return null;
    return {
      inspected,
      indexed: Number(insp?.ok ?? 0),
      notIndexed: Number(insp?.no ?? 0),
      canonicalMismatch: Number(insp?.canon ?? 0),
      pagespeedUrls,
      slowUrls: Number(psi?.slow ?? 0),
      avgMobileScore: psi?.avg != null ? Math.round(Number(psi.avg)) : null,
    };
  }

  /** Palabras seguidas que más suben y bajan (posición media del periodo frente al anterior). */
  private async keywordMoves(
    projectId: string,
    domainId: string,
    period: SeoReportPeriod,
  ): Promise<{ up: SeoReportKeywordMoveDto[]; down: SeoReportKeywordMoveDto[] }> {
    const kws = await this.admin.seoProjectKeyword.findMany({
      where: { projectId, isActive: true },
      select: { keyword: { select: { keyword: true } } },
      take: 2000,
    });
    const words = [...new Set(kws.map((k) => k.keyword.keyword))];
    if (words.length === 0) return { up: [], down: [] };
    const rows = await this.admin.$queryRaw<
      { query: string; cur: boolean; c: number; i: number; w: number }[]
    >(Prisma.sql`
      SELECT query, date >= ${period.from}::date AS cur, SUM(clicks)::float8 AS c,
             SUM(impressions)::float8 AS i, SUM(position * impressions)::float8 AS w
      FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = 'query'
        AND date BETWEEN ${period.previousFrom}::date AND ${period.to}::date
        AND query = ANY(${words}::text[])
      GROUP BY query, cur`);
    const byQuery = new Map<
      string,
      { cur?: { c: number; i: number; w: number }; prev?: { c: number; i: number; w: number } }
    >();
    for (const r of rows) {
      const s = byQuery.get(r.query) ?? {};
      s[r.cur ? 'cur' : 'prev'] = { c: Number(r.c), i: Number(r.i), w: Number(r.w) };
      byQuery.set(r.query, s);
    }
    const moves: SeoReportKeywordMoveDto[] = [];
    for (const [keyword, s] of byQuery) {
      if (!s.cur || !s.prev || s.cur.i < 10 || s.prev.i < 10) continue;
      const position = Math.round((s.cur.w / s.cur.i) * 10) / 10;
      const previousPosition = Math.round((s.prev.w / s.prev.i) * 10) / 10;
      const diff = Math.round((previousPosition - position) * 10) / 10;
      if (Math.abs(diff) < 1) continue;
      moves.push({ keyword, position, previousPosition, diff, clicks: s.cur.c });
    }
    return {
      up: moves
        .filter((m) => m.diff > 0)
        .sort((a, b) => b.diff - a.diff)
        .slice(0, 5),
      down: moves
        .filter((m) => m.diff < 0)
        .sort((a, b) => a.diff - b.diff)
        .slice(0, 5),
    };
  }

  /** Visibilidad de SISTRIX (estimación) tuya y de los competidores activos, si hay datos. */
  private async visibility(project: ProjectRow, own: string | null, period: SeoReportPeriod) {
    const competitors = await this.admin.seoCompetitor.findMany({
      where: { projectId: project.id, isActive: true },
      select: { domain: true },
      take: 10,
    });
    const domains = [...new Set([...(own ? [own] : []), ...competitors.map((c) => c.domain)])];
    if (domains.length === 0) return [];
    const rows = await this.admin.seoDomainMetric.findMany({
      where: {
        tenantId: poolOfProject(project),
        domain: { in: domains },
        country: { equals: project.country, mode: 'insensitive' },
        metric: 'visibility',
        metricDate: { lte: new Date(`${period.to}T00:00:00Z`) },
      },
      orderBy: { metricDate: 'desc' },
      take: 500,
      select: { domain: true, metricDate: true, value: true },
    });
    const out: SeoReportContentDto['visibility'] = [];
    for (const d of domains) {
      const list = rows.filter((r) => r.domain === d);
      const now = list[0];
      if (!now) continue;
      const before = list.find((r) => dateOnly(r.metricDate)! <= period.previousTo);
      out.push({
        domain: d,
        own: d === own,
        value: Number(now.value),
        previous: before ? Number(before.value) : null,
      });
    }
    return out;
  }

  /** Actuaciones cuyo resultado (28 o 7 días) se pudo comparar durante el periodo. */
  private async changesWithResult(project: ProjectRow, period: SeoReportPeriod) {
    const list = await this.changes.list(undefined, project.id, { limit: 200 });
    const out: SeoReportContentDto['changesWithResult'] = [];
    for (const ch of list.items) {
      const ready = [...ch.windows]
        .filter((w) => w.status === 'ready' && w.scope && w.availableOn <= period.to)
        .sort((a, b) => b.days - a.days)[0];
      if (!ready?.scope || ready.availableOn < period.from) continue;
      out.push({
        title: ch.title,
        date: ch.date,
        verdict: ready.scope.verdict,
        text: ready.scope.text,
      });
      if (out.length >= 10) break;
    }
    return out;
  }

  // --------------------------------------------------------------- envío

  /** «Enviármelo ahora»: el informe del último periodo cerrado, solo a quien lo pide. */
  async sendNow(
    owner: SeoOwner,
    projectId: string,
    kind: SeoReportKind,
    who: { userId?: string; superAdminId?: string },
  ): Promise<SeoReportDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    let to: string | null = null;
    if (who.userId) {
      const u = await this.admin.user.findFirst({
        where: { id: who.userId, ...(project.tenantId ? { tenantId: project.tenantId } : {}) },
        select: { email: true },
      });
      to = u?.email.toLowerCase() ?? null;
    } else if (who.superAdminId) {
      const a = await this.admin.superAdmin.findUnique({
        where: { id: who.superAdminId },
        select: { email: true },
      });
      to = a?.email.toLowerCase() ?? null;
    }
    const period = seoReportPeriod(kind, today());
    const row = await this.admin.seoReport.create({
      data: {
        tenantId: project.tenantId,
        projectId,
        kind,
        periodFrom: new Date(`${period.from}T00:00:00Z`),
        periodTo: new Date(`${period.to}T00:00:00Z`),
        periodKey: period.key,
        trigger: 'manual',
        status: 'sending',
        requestedByUserId: who.userId ?? null,
        requestedBySuperAdminId: who.superAdminId ?? null,
      },
    });
    return this.deliver(project, period, row.id, to ? [to] : []);
  }

  /**
   * Cron: cada proyecto con ese informe activado, una vez por periodo (la fila
   * de `seo_reports` se reserva antes de enviar; con varias réplicas, una sola).
   */
  async sendDueAll(kind: SeoReportKind): Promise<{ projects: number; sent: number }> {
    const period = seoReportPeriod(kind, today());
    const projects = await this.admin.seoProject.findMany({
      where: { status: 'active' },
      select: { id: true, tenantId: true, reportSettings: true },
    });
    let sent = 0;
    let due = 0;
    for (const p of projects) {
      const settings = seoReportSettingsOf(p.reportSettings);
      if (!(kind === 'weekly' ? settings.weekly : settings.monthly)) continue;
      if (!(await seoProjectEligible(this.admin, p.tenantId))) continue;
      due++;
      try {
        const claimed = await this.admin.$queryRaw<{ id: string }[]>(Prisma.sql`
          INSERT INTO seo_reports (tenant_id, project_id, kind, period_from, period_to, period_key, trigger, status)
          VALUES (${p.tenantId}::uuid, ${p.id}::uuid, ${kind}, ${period.from}::date, ${period.to}::date,
                  ${period.key}, 'cron', 'sending')
          ON CONFLICT DO NOTHING
          RETURNING id::text`);
        const id = claimed[0]?.id;
        if (!id) continue;
        const project = await this.projects.resolveProject(undefined, p.id);
        const recipients = await this.recipients(project, settings);
        const dto = await this.deliver(project, period, id, recipients);
        if (dto.status === 'sent') sent++;
      } catch (err) {
        this.logger.warn(`[seo-report] ${p.id}: ${(err as Error).message}`);
      }
    }
    return { projects: due, sent };
  }

  private async recipients(project: ProjectRow, settings: SeoReportSettings): Promise<string[]> {
    const people = await this.candidates(project);
    const chosen = settings.recipientIds.length
      ? people.filter((p) => settings.recipientIds.includes(p.id))
      : people;
    const emails = chosen.map((p) => p.email);
    if (!project.tenantId) emails.push(...settings.extraEmails);
    return [...new Set(emails.map((e) => e.toLowerCase()))];
  }

  /** Dibuja el PDF, lo guarda, envía el correo y deja constancia en la fila del informe. */
  private async deliver(
    project: ProjectRow,
    period: SeoReportPeriod,
    reportId: string,
    recipients: string[],
  ): Promise<SeoReportDto> {
    let status: SeoReportStatus = 'sent';
    let error: string | null = null;
    let pdfKey: string | null = null;
    try {
      const content = await this.build(project, period);
      const brand = await this.brand(project.tenantId);
      const html = renderSeoReportHtml(content, brand);
      const pdf = await this.renderPdf(html, `${project.name} ${period.label}`);
      pdfKey = `${project.tenantId ?? 'platform'}/seo-reports/${project.id}/${reportId}.pdf`;
      await this.files.putObject({
        bucket: 'reports',
        key: pdfKey,
        body: pdf,
        contentType: 'application/pdf',
      });
      if (recipients.length === 0) {
        status = 'empty';
      } else {
        const link = await this.files.getPresignedGetUrl(
          'reports',
          pdfKey,
          PDF_LINK_SECONDS,
          `informe-seo-${period.key}.pdf`,
        );
        const mail = this.email_(project, content, brand, link);
        for (const to of recipients) {
          await this.email.sendRendered({ to, kind: 'monthly_report', ...mail });
        }
      }
    } catch (err) {
      status = 'failed';
      error = (err as Error).message.slice(0, 500);
      this.logger.warn(`[seo-report] ${project.id}: ${error}`);
    }
    const row = await this.admin.seoReport.update({
      where: { id: reportId },
      data: {
        status,
        error,
        pdfKey,
        recipients: status === 'sent' ? recipients : [],
        sentAt: status === 'sent' ? new Date() : null,
      },
    });
    return this.toDto(row);
  }

  private async brand(tenantId: string | null) {
    if (!tenantId)
      return { name: 'TrasterOS', color: PLATFORM_COLOR, logoUrl: null as string | null };
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, portalBrandColor: true, portalLogoUrl: true },
    });
    return {
      name: t?.name ?? 'Tu negocio',
      color: safeBrandColor(t?.portalBrandColor),
      logoUrl: t?.portalLogoUrl ?? null,
    };
  }

  private async renderPdf(html: string, title: string): Promise<Buffer> {
    // Sin navegador en los tests: un PDF mínimo (el contenido se prueba con el HTML).
    if (process.env.NODE_ENV === 'test') {
      return testSeoReportPdf(title);
    }
    const puppeteer = await loadPuppeteer();
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      return Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
    } finally {
      await browser.close();
    }
  }

  /** El correo: lo más importante y los enlaces al PDF y al panel. */
  private email_(
    project: ProjectRow,
    c: SeoReportContentDto,
    brand: { name: string; color: string; logoUrl: string | null },
    pdfLink: string,
  ): { subject: string; html: string; text: string } {
    const kind = SEO_REPORT_KIND_LABELS[c.period.kind].toLowerCase();
    const subject = `Informe ${kind} de SEO: ${project.name} (${c.period.label})`;
    const panel = `${this.web()}${this.panelLink(project)}`;
    if (project.tenantId) {
      const inner = `<h2 style="margin:0 0 8px;font-size:18px">Tu informe ${escapeHtml(kind)} de SEO</h2>
<p style="margin:0 0 14px;color:#475569">${escapeHtml(c.period.label)}</p>
<ul style="padding-left:18px;margin:0 0 16px">${c.highlights
        .map((h) => `<li style="margin-bottom:6px">${escapeHtml(h)}</li>`)
        .join('')}</ul>
<p style="margin:18px 0"><a href="${escapeHtml(pdfLink)}" style="display:inline-block;background:${brand.color};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Descargar el informe (PDF)</a></p>
<p style="margin:0;font-size:13px;color:#475569">El enlace vale 7 días. Siempre lo tienes en <a href="${escapeHtml(panel)}">SEO Avanzado → Informes</a>.</p>`;
      return {
        subject,
        html: tenantEmailShell(
          { name: brand.name, logoUrl: brand.logoUrl, brandColor: brand.color },
          inner,
        ),
        text: [
          `Tu informe ${kind} de SEO (${c.period.label})`,
          '',
          ...c.highlights.map((h) => `- ${h}`),
          '',
          `Descargar el PDF (7 días): ${pdfLink}`,
          `En el panel: ${panel}`,
        ].join('\n'),
      };
    }
    const md = [
      `## Informe ${kind} de SEO: ${project.name}`,
      c.period.label,
      '',
      ...c.highlights.map((h) => `- ${h}`),
      '',
      `[Descargar el informe (PDF)](${pdfLink}) · el enlace vale 7 días.`,
      '',
      `[Verlo en el panel](${panel})`,
    ].join('\n');
    const { html, text } = renderAdminEmail(md);
    return { subject, html, text };
  }
}

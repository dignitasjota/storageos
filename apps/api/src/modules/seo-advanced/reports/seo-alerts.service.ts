import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@storageos/database';
import {
  SEO_ALERT_LIST_MAX,
  SEO_ALERT_STATUSES,
  SEO_ALERT_TYPES,
  SEO_ALERT_TYPES_WITHOUT_NOTICE,
  planSeoAlertSync,
  seoAlertSettingsOf,
  seoClicksDropAlert,
  seoGscFreshnessAlerts,
  seoPositionDropAlert,
  shiftDate,
  type SeoAlertCandidate,
  type SeoAlertSettings,
  type SeoAlertStatus,
  type SeoAlertType,
  type SeoProjectAlertDto,
  type SeoProjectAlertListDto,
  type UpdateSeoAlertSettingsInput,
} from '@storageos/shared';

import { todayInTimezone } from '../../../common/format';
import { escapeHtml, tenantEmailShell } from '../../../common/tenant-email-layout';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { EmailService } from '../../email/email.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { SeoProjectsService, type SeoOwner } from '../seo-projects.service';
import { poolOfProject } from '../sistrix/sistrix-sync.service';

import { SEO_PLATFORM_ALERT_EVENT, type SeoPlatformAlertEvent } from './seo-alert-events';
import { seoProjectEligible } from './seo-eligible';
import { tenantUsersWithPermission } from './seo-recipients';

import type { Env } from '../../../config/env.schema';

type AlertRow = Prisma.SeoAlertGetPayload<object>;

const today = () => todayInTimezone().toISOString().slice(0, 10);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** Sin una descarga nueva, el proyecto se vuelve a mirar como mucho cada 6 horas. */
const RECHECK_MS = 6 * 3600_000;
/** Categorías de indexación que son privadas (acceso, área interna, pruebas). */
const PRIVATE_CATEGORIES = ['login', 'private', 'demo'];

export interface SeoAlertQuery {
  status?: SeoAlertStatus | 'live' | undefined;
  type?: SeoAlertType | undefined;
}

export function parseSeoAlertQuery(q: Record<string, string | undefined>): SeoAlertQuery {
  return {
    status:
      q.status === 'live' || (SEO_ALERT_STATUSES as readonly string[]).includes(q.status ?? '')
        ? (q.status as SeoAlertQuery['status'])
        : undefined,
    type: (SEO_ALERT_TYPES as readonly string[]).includes(q.type ?? '')
      ? (q.type as SeoAlertType)
      : undefined,
  };
}

/**
 * Alertas de un proyecto SEO (PR 8): se calculan con lo guardado (Search
 * Console, palabras seguidas, diagnóstico y SISTRIX), una sola viva por clave
 * (índice parcial `seo_alerts_live_key`), se resuelven solas y se pueden
 * silenciar. Aviso de las nuevas: en el tenant, notificación del panel a
 * quien configura (y correo si se activa); en la plataforma, aviso del super
 * admin y Telegram/Slack. Las de SISTRIX ya las avisa su conexión: aquí solo
 * entran en la lista.
 */
@Injectable()
export class SeoAlertsService {
  private readonly logger = new Logger(SeoAlertsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private notFound() {
    return new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
  }

  private link(project: { id: string; tenantId: string | null }) {
    return project.tenantId ? '/seo-advanced#alertas' : `/admin/seo/${project.id}#alertas`;
  }

  // ----------------------------------------------------------- lectura

  async list(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoAlertQuery,
  ): Promise<SeoProjectAlertListDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const where: Prisma.SeoAlertWhereInput = {
      projectId,
      ...(q.status === 'live'
        ? { status: { in: ['open', 'silenced'] } }
        : q.status
          ? { status: q.status }
          : {}),
      ...(q.type ? { type: q.type } : {}),
    };
    const [rows, open, silenced] = await Promise.all([
      this.admin.seoAlert.findMany({
        where,
        orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
        take: SEO_ALERT_LIST_MAX,
      }),
      this.admin.seoAlert.count({ where: { projectId, status: 'open' } }),
      this.admin.seoAlert.count({ where: { projectId, status: 'silenced' } }),
    ]);
    return {
      items: rows.map((r) => this.toDto(r)),
      openCount: open,
      silencedCount: silenced,
      checkedAt: project.alertsCheckedAt?.toISOString() ?? null,
      settings: seoAlertSettingsOf(project.alertSettings),
    };
  }

  private toDto(r: AlertRow): SeoProjectAlertDto {
    return {
      id: r.id,
      type: r.type as SeoAlertType,
      severity: r.severity as SeoProjectAlertDto['severity'],
      title: r.title,
      message: r.message,
      data: (r.data ?? {}) as Record<string, unknown>,
      status: r.status as SeoAlertStatus,
      silencedUntil: r.silencedUntil?.toISOString() ?? null,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolvedBy: (r.resolvedBy as SeoProjectAlertDto['resolvedBy']) ?? null,
      notifiedAt: r.notifiedAt?.toISOString() ?? null,
    };
  }

  private async findAlert(projectId: string, id: string): Promise<AlertRow> {
    const row = await this.admin.seoAlert.findFirst({ where: { id, projectId } });
    if (!row) throw this.notFound();
    return row;
  }

  // ----------------------------------------------------------- acciones

  /** Silenciar N días: no avisa ni cuenta hasta entonces (si sigue pasando, vuelve). */
  async silence(
    owner: SeoOwner,
    projectId: string,
    id: string,
    days: number | undefined,
  ): Promise<SeoProjectAlertDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const row = await this.findAlert(projectId, id);
    if (row.status === 'resolved') return this.toDto(row);
    const n = days ?? seoAlertSettingsOf(project.alertSettings).thresholds.silenceDays;
    const updated = await this.admin.seoAlert.update({
      where: { id },
      data: { status: 'silenced', silencedUntil: new Date(Date.now() + n * 86_400_000) },
    });
    return this.toDto(updated);
  }

  /** Quitar el silencio: vuelve a estar abierta (sin avisar otra vez). */
  async unsilence(owner: SeoOwner, projectId: string, id: string): Promise<SeoProjectAlertDto> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.findAlert(projectId, id);
    if (row.status !== 'silenced') return this.toDto(row);
    const updated = await this.admin.seoAlert.update({
      where: { id },
      data: { status: 'open', silencedUntil: null },
    });
    return this.toDto(updated);
  }

  /** Darla por resuelta a mano. Si la condición sigue, la próxima revisión abre otra. */
  async resolve(owner: SeoOwner, projectId: string, id: string): Promise<SeoProjectAlertDto> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.findAlert(projectId, id);
    if (row.status === 'resolved') return this.toDto(row);
    const updated = await this.admin.seoAlert.update({
      where: { id },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: 'manual',
        silencedUntil: null,
      },
    });
    return this.toDto(updated);
  }

  async updateSettings(
    owner: SeoOwner,
    projectId: string,
    input: UpdateSeoAlertSettingsInput,
  ): Promise<SeoAlertSettings> {
    const project = await this.projects.resolveProject(owner, projectId);
    const current = input.reset
      ? seoAlertSettingsOf(null)
      : seoAlertSettingsOf(project.alertSettings);
    const next: SeoAlertSettings = {
      thresholds: {
        ...current.thresholds,
        ...(input.thresholds ?? {}),
      } as SeoAlertSettings['thresholds'],
      disabled: input.disabled ?? current.disabled,
      // El correo solo existe en el tenant (en la plataforma avisan el panel y el chat).
      email: project.tenantId ? (input.email ?? current.email) : false,
    };
    const clean = seoAlertSettingsOf(next);
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: { alertSettings: clean as unknown as Prisma.InputJsonValue },
    });
    return clean;
  }

  // --------------------------------------------------------- evaluación

  /** «Comprobar ahora». */
  async checkNow(owner: SeoOwner, projectId: string) {
    await this.projects.resolveProject(owner, projectId);
    return this.evaluate(projectId);
  }

  /**
   * Cron (cada hora, en el API): los proyectos con datos nuevos desde la
   * última revisión o sin revisar desde hace 6 horas.
   */
  async evaluateDue(): Promise<{ projects: number; created: number }> {
    const projects = await this.admin.seoProject.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        tenantId: true,
        alertsCheckedAt: true,
        diagnosticsCalculatedAt: true,
        conversionsCalculatedAt: true,
        domains: { select: { lastSyncedAt: true, checkedAt: true } },
      },
    });
    let done = 0;
    let created = 0;
    for (const p of projects) {
      const checked = p.alertsCheckedAt?.getTime() ?? 0;
      const changed = Math.max(
        p.diagnosticsCalculatedAt?.getTime() ?? 0,
        ...p.domains.map((d) =>
          Math.max(d.lastSyncedAt?.getTime() ?? 0, d.checkedAt?.getTime() ?? 0),
        ),
      );
      if (checked > 0 && changed <= checked && Date.now() - checked < RECHECK_MS) continue;
      if (!(await seoProjectEligible(this.admin, p.tenantId))) continue;
      try {
        created += (await this.evaluate(p.id)).created;
        done++;
      } catch (err) {
        this.logger.warn(`[seo-alerts] ${p.id}: ${(err as Error).message}`);
      }
    }
    return { projects: done, created };
  }

  /** Calcula lo que pasa ahora y sincroniza las alertas guardadas. */
  async evaluate(
    projectId: string,
  ): Promise<{ created: number; reopened: number; resolved: number; open: number }> {
    const project = await this.admin.seoProject.findUnique({
      where: { id: projectId },
      include: { domains: true },
    });
    if (!project) throw this.notFound();
    const settings = seoAlertSettingsOf(project.alertSettings);
    const candidates = await this.candidates(project, settings);
    const now = new Date();
    const existing = await this.admin.seoAlert.findMany({
      where: { projectId, status: { in: ['open', 'silenced'] } },
    });
    const plan = planSeoAlertSync(
      existing.map((e) => ({
        id: e.id,
        key: e.dedupKey,
        status: e.status as SeoAlertStatus,
        silencedUntil: e.silencedUntil?.toISOString() ?? null,
      })),
      candidates,
      now,
      settings.disabled,
    );

    const toNotify: { id: string; c: SeoAlertCandidate }[] = [];
    for (const c of plan.create) {
      // Entre réplicas, el índice parcial deja entrar solo una.
      const rows = await this.admin.$queryRaw<{ id: string }[]>(Prisma.sql`
        INSERT INTO seo_alerts (tenant_id, project_id, type, dedup_key, severity, title, message, data)
        VALUES (${project.tenantId}::uuid, ${projectId}::uuid, ${c.type}, ${c.key}, ${c.severity},
                ${c.title}, ${c.message}, ${JSON.stringify(c.data)}::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id::text`);
      if (rows[0]) toNotify.push({ id: rows[0].id, c });
    }
    for (const t of plan.touch) {
      await this.admin.seoAlert.update({
        where: { id: t.id },
        data: {
          severity: t.candidate.severity,
          title: t.candidate.title,
          message: t.candidate.message,
          data: t.candidate.data as Prisma.InputJsonValue,
          lastSeenAt: now,
        },
      });
    }
    for (const r of plan.reopen) {
      const res = await this.admin.seoAlert.updateMany({
        where: { id: r.id, status: 'silenced' },
        data: {
          status: 'open',
          silencedUntil: null,
          severity: r.candidate.severity,
          title: r.candidate.title,
          message: r.candidate.message,
          data: r.candidate.data as Prisma.InputJsonValue,
          lastSeenAt: now,
        },
      });
      if (res.count > 0) toNotify.push({ id: r.id, c: r.candidate });
    }
    if (plan.resolve.length > 0) {
      await this.admin.seoAlert.updateMany({
        where: { id: { in: plan.resolve }, status: { in: ['open', 'silenced'] } },
        data: { status: 'resolved', resolvedAt: now, resolvedBy: 'auto', silencedUntil: null },
      });
    }
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: { alertsCheckedAt: now },
    });

    const notify = toNotify.filter((n) => !SEO_ALERT_TYPES_WITHOUT_NOTICE.includes(n.c.type));
    if (notify.length > 0) {
      try {
        await this.notify(
          project,
          settings,
          notify.map((n) => n.c),
        );
        await this.admin.seoAlert.updateMany({
          where: { id: { in: notify.map((n) => n.id) } },
          data: { notifiedAt: now },
        });
      } catch (err) {
        this.logger.warn(`[seo-alerts] aviso de ${projectId}: ${(err as Error).message}`);
      }
    }
    const open = await this.admin.seoAlert.count({ where: { projectId, status: 'open' } });
    return {
      created: plan.create.length,
      reopened: plan.reopen.length,
      resolved: plan.resolve.length,
      open,
    };
  }

  /** Lo que pasa ahora en el proyecto. */
  private async candidates(
    project: Prisma.SeoProjectGetPayload<{ include: { domains: true } }>,
    settings: SeoAlertSettings,
  ): Promise<SeoAlertCandidate[]> {
    const out: SeoAlertCandidate[] = [];
    const t = settings.thresholds;
    const day = today();
    const primary = project.domains.find((d) => d.role === 'primary') ?? null;

    for (const d of project.domains) {
      out.push(
        ...seoGscFreshnessAlerts({
          domainId: d.id,
          domain: d.domain,
          connectionStatus: d.connectionStatus,
          lastError: d.lastError,
          dataUntil: dateOnly(d.dataUntil),
          initialDone: !!d.initialDoneAt,
          today: day,
          thresholds: t,
        }),
      );
      // Caída de clics: los 7 días hasta el último dato frente a los 7 anteriores.
      const last = dateOnly(d.dataUntil);
      if (!last || d.role === 'redirect') continue;
      const from = shiftDate(last, -6);
      const prevTo = shiftDate(from, -1);
      const prevFrom = shiftDate(prevTo, -6);
      const [cur, prev] = await Promise.all([
        this.siteWeek(d.id, from, last),
        this.siteWeek(d.id, prevFrom, prevTo),
      ]);
      const drop = seoClicksDropAlert({
        domainId: d.id,
        domain: d.domain,
        to: last,
        current: cur,
        previous: prev,
        thresholds: t,
      });
      if (drop) out.push(drop);
    }

    // Palabras seguidas de prioridad alta que bajan (en el dominio principal).
    const last = dateOnly(primary?.dataUntil);
    if (primary && last) {
      const kws = await this.admin.seoProjectKeyword.findMany({
        where: { projectId: project.id, isActive: true, priority: 1 },
        select: { keyword: { select: { keyword: true } } },
        take: 500,
      });
      const words = [...new Set(kws.map((k) => k.keyword.keyword))];
      if (words.length > 0) {
        const from = shiftDate(last, -6);
        const prevTo = shiftDate(from, -1);
        const prevFrom = shiftDate(prevTo, -6);
        const rows = await this.admin.$queryRaw<
          { query: string; cur: boolean; i: number; w: number }[]
        >(Prisma.sql`
          SELECT query, date >= ${from}::date AS cur,
                 SUM(impressions)::float8 AS i, SUM(position * impressions)::float8 AS w
          FROM seo_gsc_metrics
          WHERE domain_id = ${primary.id}::uuid AND grain = 'query'
            AND date BETWEEN ${prevFrom}::date AND ${last}::date
            AND query = ANY(${words}::text[])
          GROUP BY query, cur`);
        const stats = new Map<
          string,
          { cur?: { i: number; w: number }; prev?: { i: number; w: number } }
        >();
        for (const r of rows) {
          const s = stats.get(r.query) ?? {};
          s[r.cur ? 'cur' : 'prev'] = { i: Number(r.i), w: Number(r.w) };
          stats.set(r.query, s);
        }
        const pos = (x?: { i: number; w: number }) => (x && x.i > 0 ? x.w / x.i : null);
        for (const [keyword, s] of stats) {
          const a = seoPositionDropAlert({
            domainId: primary.id,
            domain: primary.domain,
            keyword,
            current: { position: pos(s.cur), impressions: s.cur?.i ?? 0 },
            previous: { position: pos(s.prev), impressions: s.prev?.i ?? 0 },
            thresholds: t,
          });
          if (a) out.push(a);
        }
      }
    }

    // Páginas privadas en Google y canibalización importante (diagnóstico, PR 5).
    const [findings, cannibals] = await Promise.all([
      this.admin.seoIndexFinding.findMany({
        where: {
          projectId: project.id,
          active: true,
          status: 'new',
          category: { in: PRIVATE_CATEGORIES },
        },
        orderBy: { impressions: 'desc' },
        take: 50,
      }),
      this.admin.seoCannibalization.findMany({
        where: { projectId: project.id, active: true, status: 'new', severity: 'high' },
        orderBy: { lastSeenAt: 'desc' },
        take: 50,
      }),
    ]);
    for (const f of findings) {
      out.push({
        type: 'private_page',
        key: `private_page|${f.key}`,
        severity: f.category === 'demo' ? 'medium' : 'high',
        title: `Una página privada aparece en Google: ${f.url}`,
        message: `${f.reason || 'No debería estar en Google.'} ${f.action}`.trim(),
        data: { findingId: f.id, url: f.url, category: f.category, impressions: f.impressions },
      });
    }
    for (const c of cannibals) {
      out.push({
        type: 'cannibalization',
        key: `cannibalization|${c.key}`,
        severity: 'high',
        title: `Varias páginas compiten por «${c.query}»`,
        message: `${c.reason} ${c.action}`.trim(),
        data: { cannibalizationId: c.id, query: c.query, domain: c.domain },
      });
    }

    // SISTRIX: la conexión del «fondo» del proyecto (su propia API o la de la plataforma).
    const pool = poolOfProject(project);
    const connections = await this.admin.seoProviderConnection.findMany({
      where: { tenantId: pool, provider: { in: ['sistrix_mcp', 'sistrix_api'] } },
    });
    for (const conn of connections) {
      const name = conn.provider === 'sistrix_mcp' ? 'SISTRIX (MCP)' : 'SISTRIX (API)';
      if (conn.status === 'needs_reauth') {
        out.push({
          type: 'sistrix_reconnect',
          key: `sistrix_reconnect|${conn.id}`,
          severity: 'medium',
          title: `Hay que volver a conectar ${name}`,
          message: 'La conexión caducó o se revocó. Mientras, el panel sigue con lo guardado.',
          data: { connectionId: conn.id, provider: conn.provider },
        });
      }
      if (conn.quotaExhaustedUntil && conn.quotaExhaustedUntil.getTime() > Date.now()) {
        out.push({
          type: 'sistrix_quota',
          key: `sistrix_quota|${conn.id}`,
          severity: 'low',
          title: `${name}: cuota del día agotada`,
          message: `Las consultas se reanudan el ${conn.quotaExhaustedUntil.toISOString().slice(0, 10).split('-').reverse().join('/')}.`,
          data: { connectionId: conn.id, until: conn.quotaExhaustedUntil.toISOString() },
        });
      }
    }
    return out;
  }

  private async siteWeek(domainId: string, from: string, to: string) {
    const [r] = await this.admin.$queryRaw<{ c: number | null; n: number | null }[]>(Prisma.sql`
      SELECT SUM(clicks)::float8 AS c, COUNT(*)::float8 AS n FROM seo_gsc_metrics
      WHERE domain_id = ${domainId}::uuid AND grain = 'site'
        AND date BETWEEN ${from}::date AND ${to}::date`);
    return { clicks: Number(r?.c ?? 0), days: Number(r?.n ?? 0) };
  }

  // ----------------------------------------------------------------- avisos

  private async notify(
    project: { id: string; tenantId: string | null; name: string },
    settings: SeoAlertSettings,
    alerts: SeoAlertCandidate[],
  ): Promise<void> {
    const link = this.link(project);
    if (project.tenantId) {
      for (const a of alerts) {
        await this.notifications.createForPermission(project.tenantId, 'settings:manage', {
          type: 'seo.alert',
          title: a.title,
          body: a.message.slice(0, 300),
          link,
        });
      }
      if (settings.email) await this.emailTenant(project.tenantId, alerts, link);
      return;
    }
    for (const a of alerts) {
      await this.admin.superAdminNotification.create({
        data: {
          type: 'seo.alert',
          title: `SEO (${project.name}): ${a.title}`,
          body: a.message.slice(0, 500),
          link,
          recipientId: null,
        },
      });
      this.events.emit(SEO_PLATFORM_ALERT_EVENT, {
        projectId: project.id,
        projectName: project.name,
        title: a.title,
        message: a.message,
        link,
      } satisfies SeoPlatformAlertEvent);
    }
  }

  /** Un correo con las alertas nuevas a quien configura el negocio (con su marca). */
  private async emailTenant(tenantId: string, alerts: SeoAlertCandidate[], link: string) {
    const [tenant, users] = await Promise.all([
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, portalLogoUrl: true, portalBrandColor: true },
      }),
      tenantUsersWithPermission(this.admin, tenantId, 'settings:manage'),
    ]);
    if (!tenant || users.length === 0) return;
    const web = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    const subject =
      alerts.length === 1 ? `SEO: ${alerts[0]!.title}` : `SEO: ${alerts.length} alertas nuevas`;
    const inner = `<h2 style="margin:0 0 12px;font-size:18px">Alertas de SEO</h2>${alerts
      .map(
        (a) =>
          `<p style="margin:0 0 4px;font-weight:600">${escapeHtml(a.title)}</p><p style="margin:0 0 14px;color:#475569">${escapeHtml(a.message)}</p>`,
      )
      .join(
        '',
      )}<p style="margin:20px 0 0"><a href="${escapeHtml(`${web}${link}`)}">Ver las alertas</a></p>`;
    const html = tenantEmailShell(
      { name: tenant.name, logoUrl: tenant.portalLogoUrl, brandColor: tenant.portalBrandColor },
      inner,
    );
    const text = [
      'Alertas de SEO',
      '',
      ...alerts.flatMap((a) => [a.title, a.message, '']),
      `Ver las alertas: ${web}${link}`,
    ].join('\n');
    for (const u of users) {
      await this.email.sendRendered({ to: u.email, kind: 'staff_notice', subject, html, text });
    }
  }
}

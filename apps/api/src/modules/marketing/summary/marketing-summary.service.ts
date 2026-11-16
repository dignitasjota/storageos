import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MARKETING_SUMMARY_MONTH_RE,
  WEB_ANALYTICS_START,
  hasMarketingActivity,
  leadSourceLabel,
  marketingSummaryTips,
  monthBounds,
  monthLabel,
  previousMonth,
  trafficSourceName,
  type MarketingMonthFigures,
  type MarketingPreviousCoverage,
  type MarketingSummaryConnections,
  type MarketingSummaryDto,
  type MarketingSummarySourceDto,
  type MarketingTipDto,
  type WebAnalyticsDto,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { assertFacilityAllowed } from '../../../common/facility-scope';
import { todayInTimezone, zonedDayStart, zonedNextDayStart } from '../../../common/format';
import { escapeHtml as esc } from '../../../common/tenant-email-layout';
import { tenantFeatures } from '../../../common/tenant-features';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PrismaService } from '../../database/prisma.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../../queues/queue-names';
import { FULL_MARKETING_VIEWER, type MarketingViewer } from '../marketing-viewer';
import { WebAnalyticsService } from '../web-analytics.service';

import type { Env } from '../../../config/env.schema';

const int = (n: number) => n.toLocaleString('es-ES');
const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const shiftDay = (d: string, n: number) => {
  const x = day(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
/** El origen de un visitante lo escribe cualquiera: en el correo, recortado. */
const shortName = (name: string) => (name.length > 40 ? `${name.slice(0, 39)}…` : name);
/** Días que se descargan al conectar Google Analytics y las redes. */
const GA4_INITIAL_DAYS = 120;
const SOCIAL_INITIAL_DAYS = 30;
const TIP_COLOR: Record<MarketingTipDto['kind'], string> = {
  warning: '#b45309',
  good: '#047857',
  info: '#2563eb',
};

/**
 * Resumen mensual del marketing (Marketing → Resumen y correo «Tu marketing en
 * <mes>»): la web, los contactos, las reservas y el gasto del mes frente al
 * anterior, por origen, y qué hacer. Se envía el día 4 a los propietarios.
 */
@Injectable()
export class MarketingSummaryService {
  private readonly logger = new Logger(MarketingSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly web: WebAnalyticsService,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {}

  /**
   * Resumen de un mes (`YYYY-MM`); por defecto, el mes pasado. El mes en curso
   * se compara con los mismos días del anterior (no con el mes entero).
   */
  async build(
    tenantId: string,
    monthInput?: string,
    baseViewer: MarketingViewer = FULL_MARKETING_VIEWER,
    facilityId: string | null = null,
  ): Promise<MarketingSummaryDto> {
    if (monthInput && !MARKETING_SUMMARY_MONTH_RE.test(monthInput)) {
      throw new BadRequestException({ code: 'invalid_month', message: 'Mes no válido (AAAA-MM)' });
    }
    // Un local: lo de ese local (y lo de todo el negocio, como con el alcance por local).
    if (facilityId) assertFacilityAllowed(baseViewer.facilityScope, facilityId);
    const viewer: MarketingViewer = facilityId
      ? { ...baseViewer, facilityScope: [facilityId] }
      : baseViewer;
    const tenant = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { timezone: true, marketingReportEnabled: true, createdAt: true },
        }),
      tenantId,
    );
    const tz = tenant?.timezone || 'Europe/Madrid';
    const today = todayInTimezone(tz).toISOString().slice(0, 10);
    const month = monthInput ?? previousMonth(today.slice(0, 7));
    const prevMonth = previousMonth(month);
    const bounds = monthBounds(month);
    const prevBounds = monthBounds(prevMonth);
    // Mes en curso: hasta hoy, y el anterior hasta el mismo día.
    const partial = today >= bounds.from && today <= bounds.to;
    const curTo = partial ? today : bounds.to;
    const elapsed = Math.round((day(curTo).getTime() - day(bounds.from).getTime()) / 86_400_000);
    const prevTo = partial
      ? [shiftDay(prevBounds.from, elapsed), prevBounds.to].sort()[0]!
      : prevBounds.to;
    // El mismo mes del año pasado, hasta el mismo día si el mes está en curso.
    const yearAgo = `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;
    const yearBounds = monthBounds(yearAgo);
    const yearTo = partial
      ? [shiftDay(yearBounds.from, elapsed), yearBounds.to].sort()[0]!
      : yearBounds.to;

    const [current, previous, lastYear, connections, coverage, yearCoverage] = await Promise.all([
      this.monthFigures(tenantId, { from: bounds.from, to: curTo }, tz, viewer),
      this.monthFigures(tenantId, { from: prevBounds.from, to: prevTo }, tz, viewer),
      this.monthFigures(tenantId, { from: yearBounds.from, to: yearTo }, tz, viewer),
      this.connections(tenantId),
      this.coverage(tenantId, prevBounds.from, tz, tenant?.createdAt ?? null),
      this.coverage(tenantId, yearBounds.from, tz, tenant?.createdAt ?? null),
    ]);
    const allSources: MarketingSummarySourceDto[] = current.web.sources
      .filter((s) => s.visitors + s.contacts + s.bookings + s.cost > 0)
      .map((s) => ({
        source: s.source,
        paidTraffic: s.paidTraffic,
        visitors: s.visitors,
        contacts: s.contacts,
        bookings: s.bookings,
        signed: s.signed,
        revenue: s.revenue,
        cost: s.cost,
        costPerBooking: s.costPerBooking,
      }));
    const money = { revenue: viewer.revenue, cost: viewer.cost };
    return {
      month,
      label: monthLabel(month),
      from: bounds.from,
      to: curTo,
      current: current.figures,
      previous: previous.figures,
      previousComplete: coverage,
      partial,
      lastYear: lastYear.figures,
      lastYearComplete: yearCoverage.web,
      facilityId,
      money,
      sources: allSources.slice(0, 8),
      connections,
      // Los consejos miran todos los orígenes (un canal de pago con pocas visitas también).
      tips: marketingSummaryTips({
        current: current.figures,
        previous: previous.figures,
        sources: allSources,
        connections,
        previousComplete: coverage,
        money,
      }),
      reportEnabled: tenant?.marketingReportEnabled ?? true,
    };
  }

  /**
   * ¿Hay datos de todo el mes anterior? La medición propia existe desde
   * `WEB_ANALYTICS_START` (y el negocio desde su alta); Google Analytics y las
   * redes, desde lo que se descargó al conectarlos.
   */
  private async coverage(
    tenantId: string,
    prevFrom: string,
    tz: string,
    createdAt: Date | null,
  ): Promise<MarketingPreviousCoverage> {
    const [ga4, social] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.tenantGa4.findUnique({ where: { tenantId }, select: { connectedAt: true } }),
          tx.tenantSocialAccount.findUnique({ where: { tenantId }, select: { connectedAt: true } }),
        ]),
      tenantId,
    );
    const prevStart = zonedDayStart(prevFrom, tz).getTime();
    const measuredFrom = Math.max(
      createdAt?.getTime() ?? 0,
      zonedDayStart(WEB_ANALYTICS_START, tz).getTime(),
    );
    const coveredFrom = (connectedAt: Date | null | undefined, days: number) =>
      connectedAt ? connectedAt.getTime() - days * 86_400_000 : Number.POSITIVE_INFINITY;
    return {
      web: prevStart >= measuredFrom,
      ga4: prevStart >= coveredFrom(ga4?.connectedAt, GA4_INITIAL_DAYS),
      social: prevStart >= coveredFrom(social?.connectedAt, SOCIAL_INITIAL_DAYS),
    };
  }

  async setReportEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.tenant.update({ where: { id: tenantId }, data: { marketingReportEnabled: enabled } }),
      tenantId,
    );
  }

  /** Envía el resumen del mes pasado a los propietarios. */
  async send(
    tenantId: string,
    meta?: { userId: string; ipAddress?: string | null; userAgent?: string | null },
  ): Promise<{ recipients: number; month: string }> {
    const summary = await this.build(tenantId);
    const recipients = await this.deliver(tenantId, summary);
    if (meta) {
      await this.admin.auditLog
        .create({
          data: {
            tenantId,
            userId: meta.userId,
            action: 'marketing.summary_sent',
            entityType: 'Tenant',
            entityId: tenantId,
            changes: { month: summary.month, recipients },
            ipAddress: meta.ipAddress ?? null,
            userAgent: meta.userAgent ?? null,
          },
        })
        .catch(() => undefined);
    }
    return { recipients, month: summary.month };
  }

  /**
   * Cron (días 4 a 10): tenants activos con el correo activado y sin el mes
   * enviado. Lo que falla o no tiene a quién enviarlo se intenta al día siguiente.
   */
  async sendDueAll(): Promise<{ tenants: number; sent: number }> {
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        status: { in: ['active', 'trial'] },
        marketingReportEnabled: true,
      },
      select: { id: true, timezone: true, marketingReportLastMonth: true },
    });
    let sent = 0;
    let due = 0;
    for (const t of tenants) {
      const month = previousMonth(
        todayInTimezone(t.timezone || 'Europe/Madrid')
          .toISOString()
          .slice(0, 7),
      );
      if (t.marketingReportLastMonth === month) continue;
      // Reserva el mes: si dos procesos lo intentan a la vez, solo uno lo envía.
      const claimed = await this.admin.tenant.updateMany({
        where: { id: t.id, marketingReportLastMonth: t.marketingReportLastMonth },
        data: { marketingReportLastMonth: month },
      });
      if (claimed.count === 0) continue;
      due += 1;
      let done = false;
      try {
        const summary = await this.build(t.id, month);
        // Un mes sin nada que contar no se envía (pero no se vuelve a mirar).
        if (!hasMarketingActivity(summary.current)) done = true;
        else if ((await this.deliver(t.id, summary)) > 0) {
          sent += 1;
          done = true;
        }
      } catch (err) {
        this.logger.warn(`[marketing-summary] tenant ${t.id}: ${(err as Error).message}`);
      }
      // Falló o no había a quién enviarlo: se devuelve y se intenta otro día (hasta el 10).
      if (!done) {
        await this.admin.tenant.updateMany({
          where: { id: t.id, marketingReportLastMonth: month },
          data: { marketingReportLastMonth: t.marketingReportLastMonth },
        });
      }
    }
    return { tenants: due, sent };
  }

  private async deliver(tenantId: string, summary: MarketingSummaryDto): Promise<number> {
    const owners = await this.admin.user.findMany({
      where: { tenantId, role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
      select: { email: true },
    });
    const to = [...new Set(owners.map((o) => o.email.toLowerCase()))];
    // Sin nadie a quien enviarlo no se da por enviado: se intentará otro día.
    if (to.length === 0) return 0;
    const { html, text, subject } = this.render(summary);
    await this.emailQueue.addBulk(
      to.map((email) => ({
        name: JOB_EMAIL_SEND,
        data: { to: email, kind: 'monthly_report', subject, html, text },
      })),
    );
    await this.markSent(tenantId, summary.month);
    return to.length;
  }

  private async markSent(tenantId: string, month: string): Promise<void> {
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { marketingReportLastMonth: month },
    });
  }

  private async monthFigures(
    tenantId: string,
    range: { from: string; to: string },
    tz: string,
    viewer: MarketingViewer,
  ): Promise<{ figures: MarketingMonthFigures; web: WebAnalyticsDto }> {
    const { from, to } = range;
    const since = zonedDayStart(from, tz);
    const until = zonedNextDayStart(to, tz);
    const days = Math.round((day(to).getTime() - day(from).getTime()) / 86_400_000) + 1;
    const scope = viewer.facilityScope;
    // Con alcance por local: lo de sus locales y lo que no es de ningún local.
    const inScope = scope ? { OR: [{ facilityId: null }, { facilityId: { in: scope } }] } : {};
    const [web, extra] = await Promise.all([
      this.web.reportRange(tenantId, { since, until, fromDay: from, toDay: to }, days, viewer),
      this.prisma.withTenant(async (tx) => {
        const [allContacts, spend, ads, ga4, gsc, social] = await Promise.all([
          tx.lead.count({
            where: {
              deletedAt: null,
              createdAt: { gte: since, lt: until },
              ...(scope
                ? {
                    OR: [{ preferredFacilityId: null }, { preferredFacilityId: { in: scope } }],
                  }
                : {}),
            },
          }),
          viewer.cost
            ? tx.expense.aggregate({
                where: {
                  category: 'marketing',
                  expenseDate: { gte: day(from), lte: day(to) },
                  ...inScope,
                },
                _sum: { amount: true },
              })
            : Promise.resolve({ _sum: { amount: null } }),
          tx.adMetricDaily.aggregate({
            where: { date: { gte: day(from), lte: day(to) } },
            _sum: { clicks: true },
          }),
          tx.tenantGa4.findUnique({ where: { tenantId }, select: { status: true } }),
          tx.tenantSearchConsole.findUnique({ where: { tenantId }, select: { status: true } }),
          tx.tenantSocialAccount.findUnique({ where: { tenantId }, select: { id: true } }),
        ]);
        const [ga4Sessions, searchClicks, socialRows] = await Promise.all([
          ga4?.status === 'connected' || ga4?.status === 'error'
            ? tx.ga4SourceRow
                .aggregate({
                  where: { date: { gte: day(from), lte: day(to) } },
                  _sum: { sessions: true },
                })
                .then((r) => r._sum.sessions ?? 0)
            : Promise.resolve(null),
          gsc?.status === 'connected'
            ? tx.searchConsoleRow
                .aggregate({
                  where: { date: { gte: day(from), lte: day(to) } },
                  _sum: { clicks: true },
                })
                .then((r) => r._sum.clicks ?? 0)
            : Promise.resolve(null),
          social
            ? tx.socialDailyMetric.findMany({
                where: { date: { lte: day(to) } },
                select: { network: true, date: true, reach: true, followers: true },
                orderBy: { date: 'asc' },
              })
            : Promise.resolve(null),
        ]);
        // Seguidores: el último dato de cada red hasta el fin del mes.
        let socialFollowers: number | null = null;
        let socialReach: number | null = null;
        if (socialRows) {
          const last = new Map<string, number>();
          socialReach = 0;
          for (const r of socialRows) {
            if (r.followers != null) last.set(r.network, r.followers);
            if (r.date >= day(from)) socialReach += r.reach ?? 0;
          }
          socialFollowers = last.size > 0 ? [...last.values()].reduce((a, b) => a + b, 0) : null;
        }
        return {
          allContacts,
          spend: Math.round(Number(spend._sum.amount ?? 0) * 100) / 100,
          adClicks: ads._sum.clicks ?? 0,
          ga4Sessions,
          searchClicks,
          socialFollowers,
          socialReach,
        };
      }, tenantId),
    ]);
    const t = web.totals;
    return {
      web,
      figures: {
        visitors: t.visitors,
        contactClicks: t.calls + t.whatsapp + t.emails + t.directions,
        webContacts: t.contacts,
        bookings: t.bookings,
        signed: t.signed,
        paid: t.paid,
        pendingSignature: t.pendingSignature,
        signedUnpaid: t.signedUnpaid,
        revenue: t.revenue,
        ...extra,
      },
    };
  }

  private async connections(tenantId: string): Promise<MarketingSummaryConnections> {
    const [features, data] = await Promise.all([
      tenantFeatures(this.admin, tenantId),
      this.prisma.withTenant(
        async (tx) => ({
          ga4: await tx.tenantGa4.findUnique({ where: { tenantId }, select: { status: true } }),
          gsc: await tx.tenantSearchConsole.findUnique({
            where: { tenantId },
            select: { status: true },
          }),
          ads: await tx.marketingChannel.count({
            where: {
              deletedAt: null,
              type: { in: ['google_ads', 'meta_ads'] },
              externalCampaignId: { not: null },
            },
          }),
          social: await tx.tenantSocialAccount.count(),
          links: await tx.marketingChannel.count({
            where: { deletedAt: null, utmSourceMatch: { not: null } },
          }),
        }),
        tenantId,
      ),
    ]);
    return {
      ga4: data.ga4?.status === 'connected',
      searchConsole: data.gsc?.status === 'connected',
      ads: data.ads > 0,
      channelsWithLinks: data.links,
      webPremium: features.includes('web_premium'),
      localSeo: features.includes('local_seo'),
      social: data.social > 0,
    };
  }

  private render(s: MarketingSummaryDto): { subject: string; html: string; text: string } {
    const c = s.current;
    const p = s.previous;
    const pc = s.previousComplete;
    // Sin datos de todo el mes anterior, «—» en vez de un 0 que engaña.
    const web = (n: number) => (pc.web ? int(n) : '—');
    const rows: [string, string, string][] = [
      ['Visitantes de la web', int(c.visitors), web(p.visitors)],
      ['Clics en llamar, WhatsApp y otros', int(c.contactClicks), web(p.contactClicks)],
      ['Contactos nuevos', int(c.allContacts), int(p.allContacts)],
      ['Reservas online', int(c.bookings), int(p.bookings)],
      ['Firmadas', int(c.signed), int(p.signed)],
      ['Cobrado en el primer pago (sin IVA)', eur(c.revenue), eur(p.revenue)],
      ['Gasto en marketing', eur(c.spend), eur(p.spend)],
      ['Clics en tus anuncios', int(c.adClicks), int(p.adClicks)],
    ];
    if (c.ga4Sessions != null) {
      rows.push([
        'Sesiones (Google Analytics)',
        int(c.ga4Sessions),
        pc.ga4 && p.ga4Sessions != null ? int(p.ga4Sessions) : '—',
      ]);
    }
    if (c.searchClicks != null) {
      rows.push([
        'Clics desde Google',
        int(c.searchClicks),
        p.searchClicks != null ? int(p.searchClicks) : '—',
      ]);
    }
    if (c.socialReach != null) {
      rows.push([
        'Alcance en Instagram y Facebook (suma de cada día)',
        int(c.socialReach),
        pc.social && p.socialReach != null ? int(p.socialReach) : '—',
      ]);
    }
    if (c.socialFollowers != null) {
      rows.push([
        'Seguidores en Instagram y Facebook',
        int(c.socialFollowers),
        p.socialFollowers != null ? int(p.socialFollowers) : '—',
      ]);
    }
    const base = this.config.get('WEB_BASE_URL', { infer: true });
    const url = `${base}/marketing/summary`;
    const td = 'padding:6px 10px;border-bottom:1px solid #eee';
    const table = (head: string[], body: string[][]) =>
      `<table style="width:100%;border-collapse:collapse;font-size:14px"><tr>${head
        .map((h) => `<th style="${td};text-align:left;color:#666;font-weight:600">${esc(h)}</th>`)
        .join('')}</tr>${body
        .map((cells) => `<tr>${cells.map((x) => `<td style="${td}">${esc(x)}</td>`).join('')}</tr>`)
        .join('')}</table>`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:600px">
      <h2 style="margin:0 0 4px">Tu marketing en ${esc(s.label)}</h2>
      <p style="color:#666;margin:0 0 16px">De dónde llegaron tus clientes, comparado con el mes anterior.</p>
      ${table(['', s.label, 'Mes anterior'], rows)}
      ${
        s.tips.length > 0
          ? `<h3 style="margin:24px 0 8px">Qué hacer este mes</h3><ul style="padding-left:18px;margin:0">${s.tips
              .map(
                (tip) =>
                  `<li style="margin-bottom:6px"><span style="color:${TIP_COLOR[tip.kind]}">●</span> ${esc(tip.text)}</li>`,
              )
              .join('')}</ul>`
          : ''
      }
      ${
        s.sources.length > 0
          ? `<h3 style="margin:24px 0 8px">Por origen</h3>${table(
              ['Origen', 'Visitantes', 'Contactos', 'Reservas', 'Gasto'],
              s.sources.map((x) => [
                shortName(trafficSourceName(x.source, x.paidTraffic, leadSourceLabel)),
                int(x.visitors),
                int(x.contacts),
                int(x.bookings),
                x.cost > 0 ? eur(x.cost) : '—',
              ]),
            )}`
          : ''
      }
      <p style="margin-top:24px"><a href="${esc(url)}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Ver el resumen</a></p>
      <p style="color:#888;font-size:12px;margin-top:16px">Puedes dejar de recibir este correo en Marketing → Resumen.</p>
    </div>`;
    const text = [
      `Tu marketing en ${s.label}`,
      '',
      ...rows.map(([k, v, before]) => `${k}: ${v} (mes anterior: ${before})`),
      ...(s.tips.length > 0
        ? ['', 'Qué hacer este mes:', ...s.tips.map((x) => `- ${x.text}`)]
        : []),
      '',
      `Resumen: ${url}`,
    ].join('\n');
    return { subject: `Tu marketing en ${s.label}`, html, text };
  }
}

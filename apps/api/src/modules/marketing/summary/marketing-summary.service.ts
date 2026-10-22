import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MARKETING_SUMMARY_MONTH_RE,
  hasMarketingActivity,
  marketingSummaryTips,
  monthBounds,
  monthLabel,
  previousMonth,
  type MarketingMonthFigures,
  type MarketingSummaryConnections,
  type MarketingSummaryDto,
  type MarketingSummarySourceDto,
  type MarketingTipDto,
  type WebAnalyticsDto,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { todayInTimezone, zonedDayStart, zonedNextDayStart } from '../../../common/format';
import { escapeHtml as esc } from '../../../common/tenant-email-layout';
import { tenantFeatures } from '../../../common/tenant-features';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PrismaService } from '../../database/prisma.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../../queues/queue-names';
import { WebAnalyticsService } from '../web-analytics.service';

import type { Env } from '../../../config/env.schema';

const int = (n: number) => n.toLocaleString('es-ES');
const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
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

  /** Resumen de un mes (`YYYY-MM`); por defecto, el mes pasado. */
  async build(tenantId: string, monthInput?: string): Promise<MarketingSummaryDto> {
    if (monthInput && !MARKETING_SUMMARY_MONTH_RE.test(monthInput)) {
      throw new BadRequestException({ code: 'invalid_month', message: 'Mes no válido (AAAA-MM)' });
    }
    const tenant = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { timezone: true, marketingReportEnabled: true },
        }),
      tenantId,
    );
    const tz = tenant?.timezone || 'Europe/Madrid';
    const month = monthInput ?? previousMonth(todayInTimezone(tz).toISOString().slice(0, 7));
    const prevMonth = previousMonth(month);

    const [current, previous, connections] = await Promise.all([
      this.monthFigures(tenantId, month, tz),
      this.monthFigures(tenantId, prevMonth, tz),
      this.connections(tenantId),
    ]);
    const sources: MarketingSummarySourceDto[] = current.web.sources
      .filter((s) => s.visitors + s.contacts + s.bookings + s.cost > 0)
      .slice(0, 8)
      .map((s) => ({
        source: s.source,
        visitors: s.visitors,
        contacts: s.contacts,
        bookings: s.bookings,
        signed: s.signed,
        revenue: s.revenue,
        cost: s.cost,
        costPerBooking: s.costPerBooking,
      }));
    const { from, to } = monthBounds(month);
    return {
      month,
      label: monthLabel(month),
      from,
      to,
      current: current.figures,
      previous: previous.figures,
      sources,
      connections,
      tips: marketingSummaryTips({
        current: current.figures,
        previous: previous.figures,
        sources,
        connections,
      }),
      reportEnabled: tenant?.marketingReportEnabled ?? true,
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
  async send(tenantId: string): Promise<{ recipients: number; month: string }> {
    const summary = await this.build(tenantId);
    return { recipients: await this.deliver(tenantId, summary), month: summary.month };
  }

  /** Cron mensual: tenants activos con el correo activado y sin el mes enviado. */
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
      due += 1;
      try {
        const summary = await this.build(t.id, month);
        // Un mes sin nada que contar no se envía (pero no se vuelve a mirar).
        if (hasMarketingActivity(summary.current)) {
          if ((await this.deliver(t.id, summary)) > 0) sent += 1;
        } else {
          await this.markSent(t.id, month);
        }
      } catch (err) {
        this.logger.warn(`[marketing-summary] tenant ${t.id}: ${(err as Error).message}`);
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
    if (to.length > 0) {
      const { html, text, subject } = this.render(summary);
      await this.emailQueue.addBulk(
        to.map((email) => ({
          name: JOB_EMAIL_SEND,
          data: { to: email, kind: 'monthly_report', subject, html, text },
        })),
      );
    }
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
    month: string,
    tz: string,
  ): Promise<{ figures: MarketingMonthFigures; web: WebAnalyticsDto }> {
    const { from, to } = monthBounds(month);
    const since = zonedDayStart(from, tz);
    const until = zonedNextDayStart(to, tz);
    const days = Math.round((day(to).getTime() - day(from).getTime()) / 86_400_000) + 1;
    const [web, extra] = await Promise.all([
      this.web.reportRange(tenantId, { since, until, fromDay: from, toDay: to }, days),
      this.prisma.withTenant(async (tx) => {
        const [allContacts, spend, ads, ga4, gsc] = await Promise.all([
          tx.lead.count({ where: { deletedAt: null, createdAt: { gte: since, lt: until } } }),
          tx.expense.aggregate({
            where: { category: 'marketing', expenseDate: { gte: day(from), lte: day(to) } },
            _sum: { amount: true },
          }),
          tx.adMetricDaily.aggregate({
            where: { date: { gte: day(from), lte: day(to) } },
            _sum: { clicks: true },
          }),
          tx.tenantGa4.findUnique({ where: { tenantId }, select: { status: true } }),
          tx.tenantSearchConsole.findUnique({ where: { tenantId }, select: { status: true } }),
        ]);
        const [ga4Sessions, searchClicks] = await Promise.all([
          ga4?.status === 'connected'
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
        ]);
        return {
          allContacts,
          spend: Math.round(Number(spend._sum.amount ?? 0) * 100) / 100,
          adClicks: ads._sum.clicks ?? 0,
          ga4Sessions,
          searchClicks,
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
    };
  }

  private render(s: MarketingSummaryDto): { subject: string; html: string; text: string } {
    const c = s.current;
    const p = s.previous;
    const rows: [string, string, string][] = [
      ['Visitantes de la web', int(c.visitors), int(p.visitors)],
      ['Llamadas, WhatsApp y otros clics', int(c.contactClicks), int(p.contactClicks)],
      ['Contactos nuevos', int(c.allContacts), int(p.allContacts)],
      ['Reservas online', int(c.bookings), int(p.bookings)],
      ['Firmadas', int(c.signed), int(p.signed)],
      ['Cobrado en el primer pago', eur(c.revenue), eur(p.revenue)],
      ['Gasto en marketing', eur(c.spend), eur(p.spend)],
    ];
    if (c.ga4Sessions != null) {
      rows.push(['Sesiones (Google Analytics)', int(c.ga4Sessions), int(p.ga4Sessions ?? 0)]);
    }
    if (c.searchClicks != null) {
      rows.push(['Clics desde Google', int(c.searchClicks), int(p.searchClicks ?? 0)]);
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
                x.source === 'web' ? 'Directo o sin origen' : x.source,
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

import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  previousMonthRange,
  seoReportTips,
  shiftDate,
  summarizeRange,
  type SeoMonthlyReportDto,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { escapeHtml as esc } from '../../common/tenant-email-layout';
import { tenantHasFeature } from '../../common/tenant-features';
import { AreaPagesService } from '../area-pages/area-pages.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import type { Env } from '../../config/env.schema';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const fmt = (n: number | null, digits = 1) =>
  n == null ? '—' : n.toLocaleString('es-ES', { maximumFractionDigits: digits });

/**
 * Informe mensual de SEO (extra «SEO local»): cómo fue el mes en Google frente
 * al anterior y qué mejorar. Se ve en el panel y llega por correo a los
 * propietarios el día 3 (Google publica los datos con 2-3 días de retraso).
 */
@Injectable()
export class SeoReportService {
  private readonly logger = new Logger(SeoReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly areaPages: AreaPagesService,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {}

  /** Informe de un mes (`YYYY-MM`); por defecto, el mes pasado. */
  async build(tenantId: string, month?: string): Promise<SeoMonthlyReportDto> {
    if (month && !MONTH_RE.test(month)) {
      throw new BadRequestException({ code: 'invalid_month', message: 'Mes no válido (AAAA-MM)' });
    }
    const today = new Date().toISOString().slice(0, 10);
    const range = month
      ? previousMonthRange(shiftDate(`${month}-01`, 32).slice(0, 8) + '01')
      : previousMonthRange(today);
    const prev = previousMonthRange(range.from);
    const [rows, settings] = await Promise.all([
      this.prisma.withTenant(
        (tx) =>
          tx.searchConsoleRow.findMany({
            where: {
              tenantId,
              date: {
                gte: new Date(`${prev.from}T00:00:00Z`),
                lte: new Date(`${range.to}T00:00:00Z`),
              },
            },
            select: {
              date: true,
              query: true,
              page: true,
              clicks: true,
              impressions: true,
              position: true,
            },
          }),
        tenantId,
      ),
      this.areaPages.settings(tenantId),
    ]);
    const summary = summarizeRange(
      rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        query: r.query,
        page: r.page,
        clicks: r.clicks,
        impressions: r.impressions,
        position: Number(r.position),
      })),
      { from: range.from, to: range.to, previousFrom: prev.from, previousTo: prev.to },
    );
    return {
      month: range.from.slice(0, 7),
      label: new Date(`${range.from}T00:00:00Z`).toLocaleDateString('es-ES', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      summary,
      tips: seoReportTips(summary, settings.overview),
    };
  }

  async setMonthlyReport(tenantId: string, enabled: boolean): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.tenantSearchConsole.updateMany({
          where: { tenantId },
          data: { monthlyReport: enabled },
        }),
      tenantId,
    );
  }

  /** Envía el informe del mes pasado a los propietarios. */
  async send(tenantId: string): Promise<{ recipients: number; month: string }> {
    const report = await this.build(tenantId);
    const owners = await this.admin.user.findMany({
      where: { tenantId, role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
      select: { email: true },
    });
    const to = [...new Set(owners.map((o) => o.email.toLowerCase()))];
    if (to.length > 0) {
      const { html, text, subject } = this.render(report);
      await this.emailQueue.addBulk(
        to.map((email) => ({
          name: JOB_EMAIL_SEND,
          data: { to: email, kind: 'monthly_report', subject, html, text },
        })),
      );
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.tenantSearchConsole.updateMany({
          where: { tenantId },
          data: { lastReportMonth: report.month },
        }),
      tenantId,
    );
    return { recipients: to.length, month: report.month };
  }

  /** Cron mensual: tenants con Search Console, el informe activado y el extra. */
  async sendDueAll(): Promise<{ tenants: number; sent: number }> {
    const month = previousMonthRange(new Date().toISOString().slice(0, 10)).from.slice(0, 7);
    const rows = await this.admin.tenantSearchConsole.findMany({
      where: {
        status: { in: ['connected', 'error'] },
        monthlyReport: true,
        OR: [{ lastReportMonth: null }, { lastReportMonth: { not: month } }],
      },
      select: { tenantId: true },
    });
    let sent = 0;
    for (const { tenantId } of rows) {
      if (!(await tenantHasFeature(this.admin, tenantId, 'local_seo'))) continue;
      try {
        if ((await this.send(tenantId)).recipients > 0) sent += 1;
      } catch (err) {
        this.logger.warn(`[seo-report] tenant ${tenantId}: ${(err as Error).message}`);
      }
    }
    return { tenants: rows.length, sent };
  }

  private render(r: SeoMonthlyReportDto): { subject: string; html: string; text: string } {
    const t = r.summary.totals;
    const p = r.summary.previousTotals;
    const rows: [string, string, string][] = [
      ['Clics desde Google', fmt(t.clicks, 0), fmt(p.clicks, 0)],
      ['Veces que apareces', fmt(t.impressions, 0), fmt(p.impressions, 0)],
      ['Posición media', fmt(t.position), fmt(p.position)],
    ];
    const queries = r.summary.queries.slice(0, 8);
    const zones = r.summary.pages.filter((x) => x.areaSlug).slice(0, 8);
    const url = `${this.config.get('WEB_BASE_URL', { infer: true })}/seo`;
    const td = 'padding:6px 10px;border-bottom:1px solid #eee';
    const table = (head: string[], body: string[][]) =>
      `<table style="width:100%;border-collapse:collapse;font-size:14px"><tr>${head
        .map((h) => `<th style="${td};text-align:left;color:#666;font-weight:600">${esc(h)}</th>`)
        .join('')}</tr>${body
        .map((cells) => `<tr>${cells.map((c) => `<td style="${td}">${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</table>`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:600px">
      <h2 style="margin:0 0 4px">Tu SEO en ${esc(r.label)}</h2>
      <p style="color:#666;margin:0 0 16px">Cómo te encontró la gente en Google, comparado con el mes anterior.</p>
      ${table(['', r.label, 'Mes anterior'], rows)}
      ${
        r.tips.length > 0
          ? `<h3 style="margin:24px 0 8px">Qué hacer este mes</h3><ul style="padding-left:18px;margin:0">${r.tips
              .map((tip) => `<li style="margin-bottom:6px">${esc(tip)}</li>`)
              .join('')}</ul>`
          : ''
      }
      ${
        queries.length > 0
          ? `<h3 style="margin:24px 0 8px">Búsquedas principales</h3>${table(
              ['Búsqueda', 'Clics', 'Posición'],
              queries.map((q) => [q.query, fmt(q.clicks, 0), fmt(q.position)]),
            )}`
          : ''
      }
      ${
        zones.length > 0
          ? `<h3 style="margin:24px 0 8px">Páginas de zona</h3>${table(
              ['Página', 'Clics', 'Posición'],
              zones.map((z) => [z.path, fmt(z.clicks, 0), fmt(z.position)]),
            )}`
          : ''
      }
      <p style="margin-top:24px"><a href="${esc(url)}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Ver el detalle</a></p>
      <p style="color:#888;font-size:12px;margin-top:16px">Recibes este informe por tener el extra SEO local. Puedes desactivarlo en Análisis → Posiciones en Google.</p>
    </div>`;
    const text = [
      `Tu SEO en ${r.label}`,
      '',
      ...rows.map(([k, v, before]) => `${k}: ${v} (mes anterior: ${before})`),
      ...(r.tips.length > 0 ? ['', 'Qué hacer este mes:', ...r.tips.map((x) => `- ${x}`)] : []),
      '',
      `Detalle: ${url}`,
    ].join('\n');
    return { subject: `Tu SEO en ${r.label}`, html, text };
  }
}

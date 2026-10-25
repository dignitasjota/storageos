import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { AnalyticsTrendsService } from '../analytics/analytics-trends.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { InsightsService } from '../analytics/insights.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import type { TenantMonthlyDigestResultDto } from '@storageos/shared';

const eur = (n: number): string =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const pct = (n: number): string => `${Math.round(n * 100)}%`;
/** Variación frente al mes anterior: «+12 %», «−3 %» o vacío sin base. */
const delta = (cur: number, prev: number): string => {
  if (!prev) return '';
  const change = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  return ` (${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(change)} % vs mes anterior)`;
};
/** Puntos de ocupación ganados o perdidos. */
const points = (cur: number, prev: number): string => {
  const d = Math.round((cur - prev) * 100);
  return d === 0 ? ' (igual que el mes anterior)' : ` (${d > 0 ? '+' : '−'}${Math.abs(d)} puntos)`;
};
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Informe mensual por email al operador (digest del tenant): ocupación,
 * ingresos del mes pasado (facturado vs cobrado), morosidad, inquilinos activos
 * y leads. Reutiliza los KPIs de `AnalyticsService`. Opt-in por tenant.
 */
@Injectable()
export class TenantMonthlyDigestService {
  private readonly logger = new Logger(TenantMonthlyDigestService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly analytics: AnalyticsService,
    private readonly trends: AnalyticsTrendsService,
    private readonly insights: InsightsService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {}

  async getSettings(tenantId: string): Promise<{ enabled: boolean }> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { monthlyDigestEnabled: true },
    });
    return { enabled: t?.monthlyDigestEnabled ?? false };
  }

  async updateSettings(tenantId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { monthlyDigestEnabled: enabled },
    });
    return { enabled };
  }

  /** Envía el informe del mes pasado a los propietarios del tenant. */
  async sendForTenant(tenantId: string, now = new Date()): Promise<TenantMonthlyDigestResultDto> {
    const recipients = await this.recipientsFor(tenantId);
    if (recipients.length === 0) return { sent: false, recipients: 0 };

    // Mes natural anterior (el que acaba de cerrar).
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const ym = prev.toISOString().slice(0, 7);
    const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    const ymBefore = before.toISOString().slice(0, 7);
    const monthLabel = prev.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

    const [tenant, occ, aging, custs, leads, monthly, history, churn, risk] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.analytics.getOccupancy(tenantId),
      this.analytics.getAging(tenantId),
      this.analytics.getCustomerStats(tenantId),
      this.analytics.getLeadsFunnel(tenantId),
      this.analytics.getMonthlyRevenue(tenantId, { from: ymBefore, to: ym }),
      this.trends.getOccupancyHistory(tenantId, 3),
      this.analytics.getChurn(tenantId, { from: ym, to: ym }),
      this.insights.getChurnRisk(tenantId),
    ]);
    const rev = monthly.points.find((p) => p.yearMonth === ym) ?? { invoiced: 0, collected: 0 };
    const revBefore = monthly.points.find((p) => p.yearMonth === ymBefore) ?? {
      invoiced: 0,
      collected: 0,
    };
    const occLast = history.points.find((p) => p.yearMonth === ym);
    const occBefore = history.points.find((p) => p.yearMonth === ymBefore);
    const lost = churn.months[0];
    const businessName = tenant?.name ?? 'tu negocio';

    const rows: Array<[string, string]> = [
      [
        'Ocupación',
        `${pct(occ.physicalOccupancy)} (${occ.occupiedUnits}/${occ.totalUnits} trasteros)`,
      ],
      ...(occLast && occBefore
        ? ([
            [
              `Ocupación al cerrar ${monthLabel}`,
              `${pct(occLast.occupancy)}${points(occLast.occupancy, occBefore.occupancy)}`,
            ],
          ] as Array<[string, string]>)
        : []),
      ['MRR (ingreso recurrente)', `${eur(occ.mrrActual)}/mes`],
      [
        `Facturado en ${monthLabel}`,
        `${eur(rev.invoiced)}${delta(rev.invoiced, revBefore.invoiced)}`,
      ],
      [
        `Cobrado en ${monthLabel}`,
        `${eur(rev.collected)}${delta(rev.collected, revBefore.collected)}`,
      ],
      ...(lost
        ? ([
            [
              `Bajas en ${monthLabel}`,
              `${lost.ended} (${(lost.churnRate * 100).toFixed(1)} % de los activos)`,
            ],
          ] as Array<[string, string]>)
        : []),
      ['Inquilinos con riesgo alto de baja', String(risk.summary.high)],
      ['Pendiente de cobro (morosidad)', eur(aging.totalOutstanding)],
      ['Inquilinos activos', String(custs.withActiveContract)],
      ['Contactos recibidos (30 días)', String(leads.total)],
      ['Leads ganados', String(leads.totals.won)],
    ];

    const htmlRows = rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 12px;color:#555">${esc(k)}</td><td style="padding:6px 12px;text-align:right;font-weight:600">${esc(v)}</td></tr>`,
      )
      .join('');
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px">
      <h2 style="margin:0 0 4px">Resumen de ${esc(monthLabel)}</h2>
      <p style="color:#666;margin:0 0 16px">${esc(businessName)} — cómo fue el mes de un vistazo.</p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #eee">${htmlRows}</table>
      <p style="color:#888;font-size:12px;margin-top:16px">Recibes este resumen porque lo activaste en Ajustes → Facturación. Puedes desactivarlo ahí cuando quieras.</p>
    </div>`;
    const text = `Resumen de ${monthLabel} — ${businessName}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}`;

    await this.emailQueue.addBulk(
      recipients.map((to) => ({
        name: JOB_EMAIL_SEND,
        data: { to, kind: 'monthly_report', subject: `Tu resumen de ${monthLabel}`, html, text },
      })),
    );
    return { sent: true, recipients: recipients.length };
  }

  /** Cron mensual: envía el digest a todos los tenants que lo activaron. */
  async sendDueAll(): Promise<{ tenants: number; sent: number }> {
    const tenants = await this.admin.tenant.findMany({
      where: { monthlyDigestEnabled: true, deletedAt: null, status: { in: ['active', 'trial'] } },
      select: { id: true },
    });
    let sent = 0;
    for (const t of tenants) {
      try {
        const r = await this.sendForTenant(t.id);
        if (r.sent) sent += 1;
      } catch (err) {
        this.logger.warn(
          `Digest del tenant ${t.id} falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { tenants: tenants.length, sent };
  }

  /** Propietarios verificados y activos del tenant (fallback al billingEmail). */
  private async recipientsFor(tenantId: string): Promise<string[]> {
    const owners = await this.admin.user.findMany({
      where: { tenantId, role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
      select: { email: true },
    });
    const emails = new Set(owners.map((o) => o.email.toLowerCase()));
    if (emails.size === 0) {
      const tenant = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { billingEmail: true },
      });
      if (tenant?.billingEmail) emails.add(tenant.billingEmail.toLowerCase());
    }
    return [...emails];
  }
}

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import type { TenantMonthlyDigestResultDto } from '@storageos/shared';

const eur = (n: number): string =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const pct = (n: number): string => `${Math.round(n * 100)}%`;
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
    const monthLabel = prev.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

    const [tenant, occ, aging, custs, leads, monthly] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.analytics.getOccupancy(tenantId),
      this.analytics.getAging(tenantId),
      this.analytics.getCustomerStats(tenantId),
      this.analytics.getLeadsFunnel(tenantId),
      this.analytics.getMonthlyRevenue(tenantId, { from: ym, to: ym }),
    ]);
    const rev = monthly.points[0] ?? { invoiced: 0, collected: 0 };
    const businessName = tenant?.name ?? 'tu negocio';

    const rows: Array<[string, string]> = [
      [
        'Ocupación',
        `${pct(occ.physicalOccupancy)} (${occ.occupiedUnits}/${occ.totalUnits} trasteros)`,
      ],
      ['MRR (ingreso recurrente)', `${eur(occ.mrrActual)}/mes`],
      [`Facturado en ${monthLabel}`, eur(rev.invoiced)],
      [`Cobrado en ${monthLabel}`, eur(rev.collected)],
      ['Pendiente de cobro (morosidad)', eur(aging.totalOutstanding)],
      ['Inquilinos activos', String(custs.withActiveContract)],
      ['Leads nuevos', String(leads.totals.new)],
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
        data: { to, subject: `Tu resumen de ${monthLabel}`, html, text },
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

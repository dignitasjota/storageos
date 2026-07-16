import { Inject, Injectable, Logger } from '@nestjs/common';

import { EMAIL_PROVIDER, type EmailProvider } from '../email/providers/email-provider';

import { AdminMetricsService } from './admin-metrics.service';
import { AdminTenantsService } from './admin-tenants.service';
import { MrrSnapshotService } from './mrr-snapshot.service';
import { PlatformAlertsService } from './platform-alerts.service';

import type { AdminWeeklyDigestResultDto } from '@storageos/shared';

/** Escapa texto interpolado en el HTML del email (nombres/slugs de tenant). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Formatea un importe en euros (divisa del SaaS). */
function euro(n: number): string {
  return `${n.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} €`;
}

/**
 * Resumen semanal de KPIs por email al super admin: MRR y su variación, net new
 * MRR, churn del mes, ARPU, nuevos tenants, trials por convertir y tickets
 * abiertos — para que el fundador reciba los números sin entrar al panel.
 *
 * Reutiliza los KPIs ya calculados (`AdminMetricsService.getOverview` +
 * `MrrSnapshotService.getMovements`) y la config del singleton
 * `platform_alert_settings` (mismo destinatario `alertEmail`).
 */
@Injectable()
export class WeeklyDigestService {
  private readonly logger = new Logger(WeeklyDigestService.name);

  constructor(
    private readonly metrics: AdminMetricsService,
    private readonly mrr: MrrSnapshotService,
    private readonly tenants: AdminTenantsService,
    private readonly alerts: PlatformAlertsService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /**
   * Envía el resumen semanal si está activo y hay un email destino. Lo disparan
   * el cron semanal (lunes 08:00) y el botón «Enviar ahora».
   */
  async sendWeeklyDigest(): Promise<AdminWeeklyDigestResultDto> {
    const settings = await this.alerts.getSettings();
    if (!settings.weeklyDigestEnabled || !settings.alertEmail) {
      return { sent: false, reason: 'disabled_or_no_email' };
    }

    const [overview, movements, atRisk] = await Promise.all([
      this.metrics.getOverview(),
      this.mrr.getMovements(1),
      this.tenants.getAtRisk(),
    ]);

    // Último mes de movimientos (variación de MRR); null si aún calentando.
    const lastMovement =
      movements.months.length > 0 ? movements.months[movements.months.length - 1]! : null;
    const { html, text } = this.render(overview, lastMovement, atRisk);

    await this.email.send({
      to: settings.alertEmail,
      subject: `[TrasterOS] Resumen semanal: MRR ${euro(overview.mrr.total)} · ${overview.tenants.active} activos`,
      html,
      text,
    });
    this.logger.log(`[weekly-digest] resumen enviado a ${settings.alertEmail}`);
    return { sent: true, reason: null };
  }

  /** Renderiza el email HTML + texto plano en español. */
  private render(
    overview: Awaited<ReturnType<AdminMetricsService['getOverview']>>,
    lastMovement: {
      newMrr: number;
      churn: number;
      net: number;
      nrr: number | null;
    } | null,
    atRisk: Awaited<ReturnType<AdminTenantsService['getAtRisk']>>,
  ): { html: string; text: string } {
    const netNew = lastMovement ? lastMovement.net : 0;
    const churn = lastMovement ? lastMovement.churn : 0;
    const nrr = lastMovement && lastMovement.nrr !== null ? `${lastMovement.nrr} %` : '—';

    // KPIs principales (label, valor).
    const kpis: [string, string][] = [
      ['MRR', euro(overview.mrr.total)],
      ['Net New MRR (último mes)', `${netNew >= 0 ? '+' : ''}${euro(netNew)}`],
      ['MRR perdido por bajas', euro(churn)],
      ['NRR', nrr],
      ['ARPU', euro(overview.averageRevenuePerTenant)],
      ['Tenants activos', String(overview.tenants.active)],
      ['Nuevos tenants (este mes)', String(overview.signupsThisMonth)],
      ['Bajas (este mes)', String(overview.cancellationsThisMonth)],
      ['Trials en curso', String(overview.tenants.trial)],
      ['Trials por convertir (≤7 d)', String(overview.trialsExpiringSoon)],
      ['Tickets de soporte abiertos', String(overview.openSupportTickets)],
    ];

    // Top tenants en riesgo (past_due + trials por expirar), primeros 5.
    const risk = [...atRisk.pastDue, ...atRisk.trialExpiring].slice(0, 5);

    // --- Texto plano ---
    const textLines: string[] = ['Resumen semanal de KPIs — TrasterOS', ''];
    for (const [label, value] of kpis) textLines.push(`- ${label}: ${value}`);
    if (risk.length > 0) {
      textLines.push('', 'Tenants a vigilar:');
      for (const t of risk) textLines.push(`- ${t.name} (${t.slug}) — ${t.detail}`);
    }

    // --- HTML ---
    const rows = kpis
      .map(
        ([label, value]) =>
          `<tr><td style="padding:6px 12px;color:#555">${escapeHtml(label)}</td><td style="padding:6px 12px;font-weight:600;text-align:right">${escapeHtml(value)}</td></tr>`,
      )
      .join('');
    let riskHtml = '';
    if (risk.length > 0) {
      const items = risk
        .map(
          (t) => `<li>${escapeHtml(t.name)} (${escapeHtml(t.slug)}) — ${escapeHtml(t.detail)}</li>`,
        )
        .join('');
      riskHtml = `<h3 style="margin:20px 0 8px">Tenants a vigilar</h3><ul>${items}</ul>`;
    }
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;color:#111">
<h2 style="margin:0 0 4px">Resumen semanal de KPIs</h2>
<p style="margin:0 0 16px;color:#777">TrasterOS · plataforma</p>
<table style="border-collapse:collapse;min-width:320px">${rows}</table>
${riskHtml}
</div>`;

    return { html, text: textLines.join('\n') };
  }
}

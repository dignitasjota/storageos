import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/providers/email-provider';

import type {
  PlatformAlertRunResultDto,
  PlatformAlertSettingsDto,
  UpdatePlatformAlertSettingsInput,
} from '@storageos/shared';

/**
 * Alertas proactivas de plataforma: el super admin recibe un digest por email
 * con los tenants en `past_due` y los trials que expiran pronto, para actuar a
 * tiempo (retención/cobro). Config en `platform_alert_settings` (singleton).
 */
@Injectable()
export class PlatformAlertsService {
  private readonly logger = new Logger(PlatformAlertsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /** Devuelve la config (singleton); la crea con defaults si no existe. */
  async getSettings(): Promise<PlatformAlertSettingsDto> {
    let row = await this.admin.platformAlertSettings.findFirst();
    row ??= await this.admin.platformAlertSettings.create({ data: {} });
    return this.toDto(row);
  }

  async updateSettings(input: UpdatePlatformAlertSettingsInput): Promise<PlatformAlertSettingsDto> {
    const current = await this.admin.platformAlertSettings.findFirst();
    const data = {
      enabled: input.enabled,
      alertEmail: input.alertEmail ? input.alertEmail : null,
      notifyPastDue: input.notifyPastDue,
      notifyTrialExpiring: input.notifyTrialExpiring,
      trialExpiringDays: input.trialExpiringDays,
      // Solo se tocan si vienen en el input (sección de lifecycle independiente).
      ...(input.lifecycleEnabled !== undefined ? { lifecycleEnabled: input.lifecycleEnabled } : {}),
      ...(input.sendWelcome !== undefined ? { sendWelcome: input.sendWelcome } : {}),
      ...(input.sendTrialReminders !== undefined
        ? { sendTrialReminders: input.sendTrialReminders }
        : {}),
      ...(input.sendPastDue !== undefined ? { sendPastDue: input.sendPastDue } : {}),
      ...(input.weeklyDigestEnabled !== undefined
        ? { weeklyDigestEnabled: input.weeklyDigestEnabled }
        : {}),
    };
    const row = current
      ? await this.admin.platformAlertSettings.update({ where: { id: current.id }, data })
      : await this.admin.platformAlertSettings.create({ data });
    return this.toDto(row);
  }

  /**
   * Evalúa las señales y, si las alertas están activas y hay algo que reportar,
   * envía el digest al `alertEmail`. Idempotente respecto al estado (lo puede
   * disparar el cron diario o el botón «Evaluar ahora»).
   */
  async evaluateAndNotify(): Promise<PlatformAlertRunResultDto> {
    const settings = await this.getSettings();
    if (!settings.enabled || !settings.alertEmail) {
      return { sent: false, pastDue: 0, trialExpiring: 0, reason: 'disabled_or_no_email' };
    }
    const now = new Date();
    const trialLimit = new Date(now.getTime() + settings.trialExpiringDays * 24 * 60 * 60 * 1000);

    const [pastDue, trialExpiring] = await Promise.all([
      settings.notifyPastDue
        ? this.admin.tenant.findMany({
            where: { deletedAt: null, subscription: { status: 'past_due' } },
            select: { name: true, slug: true },
            orderBy: { name: 'asc' },
          })
        : Promise.resolve([]),
      settings.notifyTrialExpiring
        ? this.admin.tenant.findMany({
            where: {
              deletedAt: null,
              status: 'trial',
              trialEndsAt: { gte: now, lte: trialLimit },
            },
            select: { name: true, slug: true, trialEndsAt: true },
            orderBy: { trialEndsAt: 'asc' },
          })
        : Promise.resolve([]),
    ]);

    if (pastDue.length === 0 && trialExpiring.length === 0) {
      return { sent: false, pastDue: 0, trialExpiring: 0, reason: 'no_signals' };
    }

    const { html, text } = this.renderDigest(pastDue, trialExpiring);
    await this.email.send({
      to: settings.alertEmail,
      subject: `[StorageOS] Alerta de plataforma: ${pastDue.length} pago(s) fallido(s), ${trialExpiring.length} trial(es) por expirar`,
      html,
      text,
    });
    this.logger.log(
      `[platform-alerts] digest enviado a ${settings.alertEmail} (pastDue=${pastDue.length}, trialExpiring=${trialExpiring.length})`,
    );
    return {
      sent: true,
      pastDue: pastDue.length,
      trialExpiring: trialExpiring.length,
      reason: null,
    };
  }

  private renderDigest(
    pastDue: { name: string; slug: string }[],
    trialExpiring: { name: string; slug: string; trialEndsAt: Date | null }[],
  ): { html: string; text: string } {
    const lines: string[] = [];
    const htmlParts: string[] = [];
    if (pastDue.length > 0) {
      lines.push('Pagos fallidos (past_due):');
      htmlParts.push('<h3>Pagos fallidos (past_due)</h3><ul>');
      for (const t of pastDue) {
        lines.push(`- ${t.name} (${t.slug})`);
        htmlParts.push(`<li>${t.name} (${t.slug})</li>`);
      }
      htmlParts.push('</ul>');
    }
    if (trialExpiring.length > 0) {
      lines.push('', 'Trials por expirar:');
      htmlParts.push('<h3>Trials por expirar</h3><ul>');
      for (const t of trialExpiring) {
        const d = t.trialEndsAt ? t.trialEndsAt.toISOString().slice(0, 10) : '—';
        lines.push(`- ${t.name} (${t.slug}) — ${d}`);
        htmlParts.push(`<li>${t.name} (${t.slug}) — ${d}</li>`);
      }
      htmlParts.push('</ul>');
    }
    return {
      html: `<div>${htmlParts.join('')}</div>`,
      text: lines.join('\n'),
    };
  }

  private toDto(row: {
    enabled: boolean;
    alertEmail: string | null;
    notifyPastDue: boolean;
    notifyTrialExpiring: boolean;
    trialExpiringDays: number;
    lifecycleEnabled: boolean;
    sendWelcome: boolean;
    sendTrialReminders: boolean;
    sendPastDue: boolean;
    weeklyDigestEnabled: boolean;
  }): PlatformAlertSettingsDto {
    return {
      enabled: row.enabled,
      alertEmail: row.alertEmail,
      notifyPastDue: row.notifyPastDue,
      notifyTrialExpiring: row.notifyTrialExpiring,
      trialExpiringDays: row.trialExpiringDays,
      lifecycleEnabled: row.lifecycleEnabled,
      sendWelcome: row.sendWelcome,
      sendTrialReminders: row.sendTrialReminders,
      sendPastDue: row.sendPastDue,
      weeklyDigestEnabled: row.weeklyDigestEnabled,
    };
  }
}

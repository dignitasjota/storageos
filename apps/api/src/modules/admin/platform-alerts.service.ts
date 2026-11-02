import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { renderAdminEmail } from '@storageos/shared';

import { formatDateLong } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';

import type { Env } from '../../config/env.schema';
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

  private readonly webBase: string;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    config: ConfigService<Env, true>,
  ) {
    this.webBase = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

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
      ...(input.sendActivation !== undefined ? { sendActivation: input.sendActivation } : {}),
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

    // Como «Hoy» y «En riesgo»: ni exentos ni suspendidos o dados de baja.
    const [pastDue, trialExpiring] = await Promise.all([
      settings.notifyPastDue
        ? this.admin.tenant.findMany({
            where: {
              deletedAt: null,
              billingExempt: false,
              status: { in: ['active', 'trial'] },
              subscription: { status: 'past_due' },
            },
            select: { id: true, name: true, slug: true },
            orderBy: { name: 'asc' },
          })
        : Promise.resolve([]),
      settings.notifyTrialExpiring
        ? this.admin.tenant.findMany({
            where: {
              deletedAt: null,
              billingExempt: false,
              status: 'trial',
              trialEndsAt: { gte: now, lte: trialLimit },
            },
            select: { id: true, name: true, slug: true, trialEndsAt: true },
            orderBy: { trialEndsAt: 'asc' },
          })
        : Promise.resolve([]),
    ]);

    if (pastDue.length === 0 && trialExpiring.length === 0) {
      return { sent: false, pastDue: 0, trialExpiring: 0, reason: 'no_signals' };
    }

    const { html, text } = this.renderDigest(pastDue, trialExpiring);
    // Por el servicio común: queda en «Correos enviados» y respeta la lista de bloqueos.
    await this.email.sendRendered({
      to: settings.alertEmail,
      kind: 'admin_alert',
      subject: `[TrasterOS] Alerta de plataforma: ${pastDue.length} pago(s) fallido(s), ${trialExpiring.length} prueba(s) por terminar`,
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

  /** Markdown escapado por `renderAdminEmail`: el nombre del tenant lo elige el tenant. */
  private renderDigest(
    pastDue: { id: string; name: string; slug: string }[],
    trialExpiring: { id: string; name: string; slug: string; trialEndsAt: Date | null }[],
  ): { html: string; text: string } {
    const clean = (v: string) => v.replace(/[[\]()*_#`]/g, ' ').trim();
    const link = (t: { id: string; name: string; slug: string }) =>
      `[${clean(t.name)}](${this.webBase}/admin/tenants/${t.id}) (${clean(t.slug)})`;
    const lines: string[] = [];
    if (pastDue.length > 0) {
      lines.push('## Pagos fallidos', ...pastDue.map((t) => `- ${link(t)}`), '');
    }
    if (trialExpiring.length > 0) {
      lines.push(
        '## Pruebas que terminan pronto',
        ...trialExpiring.map(
          (t) => `- ${link(t)} — ${t.trialEndsAt ? formatDateLong(t.trialEndsAt) : '—'}`,
        ),
        '',
      );
    }
    lines.push(`[[boton: Abrir «Hoy» | ${this.webBase}/admin/today]]`);
    return renderAdminEmail(lines.join('\n'));
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
    sendActivation: boolean;
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
      sendActivation: row.sendActivation,
      weeklyDigestEnabled: row.weeklyDigestEnabled,
    };
  }
}

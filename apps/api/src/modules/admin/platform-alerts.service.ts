import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { renderAdminEmail } from '@storageos/shared';

import { currentMonth, formatDateLong } from '../../common/format';
import { OWN_KEY_AI_FEATURES } from '../../common/saas-metrics';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';

import { PlatformAlertLogService } from './platform-alert-log.service';

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
  private readonly aiPrices: { input: number; output: number };

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    private readonly log: PlatformAlertLogService,
    config: ConfigService<Env, true>,
  ) {
    this.webBase = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.aiPrices = {
      input: config.get('AI_COST_INPUT_PER_MTOK_USD', { infer: true }),
      output: config.get('AI_COST_OUTPUT_PER_MTOK_USD', { infer: true }),
    };
  }

  /** Gasto de IA del mes si supera el aviso del panel (null si no hay aviso o no llega). */
  private async aiOverBudget(): Promise<{ costUsd: number; alertUsd: number } | null> {
    const ai = await this.admin.platformAiSettings.findFirst({
      select: { monthlyCostAlertUsd: true },
    });
    if (ai?.monthlyCostAlertUsd == null) return null;
    const alertUsd = Number(ai.monthlyCostAlertUsd);
    const tokens = await this.admin.aiUsageEvent.aggregate({
      where: {
        countsAsQuery: false,
        ownKey: false,
        feature: { notIn: OWN_KEY_AI_FEATURES },
        createdAt: { gte: currentMonth().start },
      },
      _sum: { inputTokens: true, outputTokens: true },
    });
    const costUsd =
      ((tokens._sum.inputTokens ?? 0) * this.aiPrices.input +
        (tokens._sum.outputTokens ?? 0) * this.aiPrices.output) /
      1_000_000;
    return costUsd >= alertUsd ? { costUsd: Math.round(costUsd * 100) / 100, alertUsd } : null;
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
      alertEmail: input.alertEmail ? alertRecipients(input.alertEmail).join(', ') : null,
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
      ...(input.dailyHour !== undefined ? { dailyHour: input.dailyHour } : {}),
      ...(input.chatContactEnabled !== undefined
        ? { chatContactEnabled: input.chatContactEnabled }
        : {}),
    };
    const row = current
      ? await this.admin.platformAlertSettings.update({ where: { id: current.id }, data })
      : await this.admin.platformAlertSettings.create({ data });
    return this.toDto(row);
  }

  /**
   * Manda un aviso a cada email de las alertas (por el servicio común: queda en
   * «Correos enviados» y respeta los bloqueos) y lo anota en el historial.
   * Devuelve a cuántos llegó.
   */
  async emailAdmins(args: {
    kind: string;
    subject: string;
    html: string;
    text: string;
    /** A quién escribir si en Alertas no hay ningún email. */
    fallbackTo?: string | undefined;
  }): Promise<number> {
    const row = await this.admin.platformAlertSettings.findFirst();
    const configured = alertRecipients(row?.alertEmail ?? '');
    const recipients =
      configured.length > 0 ? configured : args.fallbackTo ? [args.fallbackTo] : [];
    let ok = 0;
    for (const to of recipients) {
      try {
        const res = await this.email.sendRendered({
          to,
          kind: 'admin_alert',
          subject: args.subject,
          html: args.html,
          text: args.text,
        });
        if (!res.suppressed) ok += 1;
        await this.log.record({
          channel: 'email',
          kind: args.kind,
          ok: !res.suppressed,
          summary: `${args.subject} → ${to}`,
          error: res.suppressed ? 'Dirección bloqueada' : null,
        });
      } catch (err) {
        await this.log.record({
          channel: 'email',
          kind: args.kind,
          ok: false,
          summary: `${args.subject} → ${to}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return ok;
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

    const ai = await this.aiOverBudget();
    if (pastDue.length === 0 && trialExpiring.length === 0 && !ai) {
      return { sent: false, pastDue: 0, trialExpiring: 0, reason: 'no_signals' };
    }

    const { html, text } = this.renderDigest(pastDue, trialExpiring, ai);
    await this.emailAdmins({
      kind: 'daily',
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
    ai: { costUsd: number; alertUsd: number } | null = null,
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
    if (ai) {
      lines.push(
        '## Gasto de IA',
        `El asistente IA lleva **${ai.costUsd} $** este mes (aviso a partir de ${ai.alertUsd} $). [Ver el uso](${this.webBase}/admin/ai)`,
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
    dailyHour: number;
    chatContactEnabled: boolean;
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
      dailyHour: row.dailyHour,
      chatContactEnabled: row.chatContactEnabled,
    };
  }
}

/** Los emails del campo de alertas (uno o varios separados por comas). */
export function alertRecipients(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

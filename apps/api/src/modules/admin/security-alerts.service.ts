import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaAdminService } from '../database/prisma-admin.service';
import {
  ADMIN_FAILURE_EVENT_TYPES,
  EMAIL_FAILURE_EVENT_TYPES,
  IP_FAILURE_EVENT_TYPES,
} from '../security-events/security-events.service';

import { claimAlert } from './alert-state';
import { ChatAlertsService } from './chat-alerts.service';
import { PlatformAlertsService } from './platform-alerts.service';

import type { Env } from '../../config/env.schema';

/** Tipo de identificador agregado en el scan. */
type AlertKind = 'email' | 'ip' | 'reuse';

interface AlertArgs {
  kind: AlertKind;
  identifier: string;
  count: number;
  windowMin: number;
  cooldownMin: number;
}

/**
 * Detecta intentos de fuerza bruta agregando los `security_events` recientes y
 * avisa al super admin por todos sus canales: notificación del panel (y push),
 * los emails de Alertas al admin y Telegram/Slack. `SECURITY_ALERT_EMAIL` solo
 * se usa si en Alertas no hay ningún email.
 *
 * Se ejecuta periódicamente (`SecurityAlertsCron`) o bajo demanda con
 * `POST /admin/security-alerts/scan`. Cada email/IP se avisa una vez por ventana
 * (`security_alert_states`): no se repite entre réplicas ni al reiniciar.
 */
@Injectable()
export class SecurityAlertsService {
  private readonly logger = new Logger(SecurityAlertsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly platformAlerts: PlatformAlertsService,
    private readonly chat: ChatAlertsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Escanea los eventos de la ventana y avisa de cada email/IP que supere el
   * umbral. Devuelve cuántas alertas ha lanzado (sin las ya avisadas).
   */
  async scanAndAlert(): Promise<{ alertsSent: number }> {
    const threshold = this.config.get('SECURITY_BRUTE_FORCE_THRESHOLD', { infer: true });
    const windowMin = this.config.get('SECURITY_BRUTE_FORCE_WINDOW_MINUTES', { infer: true });
    const cutoff = new Date(Date.now() - windowMin * 60_000);

    const emailGroups = await this.admin.securityEvent.groupBy({
      by: ['emailAttempted'],
      where: {
        occurredAt: { gte: cutoff },
        eventType: { in: [...EMAIL_FAILURE_EVENT_TYPES] },
        emailAttempted: { not: null },
      },
      _count: { _all: true },
      having: { emailAttempted: { _count: { gte: threshold } } },
    });

    // Por IP también cuenta el tenant inexistente: indica un barrido de slugs.
    const ipGroups = await this.admin.securityEvent.groupBy({
      by: ['ipAddress'],
      where: {
        occurredAt: { gte: cutoff },
        eventType: { in: [...IP_FAILURE_EVENT_TYPES] },
        ipAddress: { not: null },
      },
      _count: { _all: true },
      having: { ipAddress: { _count: { gte: threshold } } },
    });

    // Una sola sesión reutilizada ya es grave: no espera al umbral.
    const reuseGroups = await this.admin.securityEvent.groupBy({
      by: ['emailAttempted'],
      where: {
        occurredAt: { gte: cutoff },
        eventType: 'refresh_token_reuse',
        emailAttempted: { not: null },
      },
      _count: { _all: true },
    });

    const settings = await this.admin.platformSecuritySettings.findFirst();
    const cooldownMin = settings?.alertCooldownMinutes ?? 60;
    let alertsSent = 0;
    for (const group of reuseGroups) {
      if (!group.emailAttempted) continue;
      const sent = await this.maybeAlert({
        kind: 'reuse',
        identifier: group.emailAttempted,
        count: group._count._all,
        windowMin,
        cooldownMin,
      });
      if (sent) alertsSent++;
    }
    for (const group of emailGroups) {
      if (!group.emailAttempted) continue;
      const sent = await this.maybeAlert({
        kind: 'email',
        identifier: group.emailAttempted,
        count: group._count._all,
        windowMin,
        cooldownMin,
      });
      if (sent) alertsSent++;
    }
    for (const group of ipGroups) {
      if (!group.ipAddress) continue;
      const sent = await this.maybeAlert({
        kind: 'ip',
        identifier: group.ipAddress,
        count: group._count._all,
        windowMin,
        cooldownMin,
      });
      if (sent) alertsSent++;
    }

    return { alertsSent };
  }

  /** Reserva el aviso de este email/IP para la ventana: solo lo gana una réplica. */
  private async claim(args: AlertArgs): Promise<boolean> {
    return claimAlert(this.admin, args.kind, args.identifier, args.cooldownMin);
  }

  private async maybeAlert(args: AlertArgs): Promise<boolean> {
    if (!(await this.claim(args))) {
      this.logger.debug(`Alerta ya enviada en esta ventana: ${args.kind}=${args.identifier}`);
      return false;
    }
    const againstPanel = await this.touchesAdminPanel(args);
    const target = againstPanel ? ' en el panel admin' : '';
    const title =
      args.kind === 'reuse'
        ? 'Sesión reutilizada: posible robo de sesión'
        : `Posible ataque de fuerza bruta${target}`;
    const detail =
      args.kind === 'reuse'
        ? `Se ha reutilizado una sesión ya renovada de ${args.identifier}. Se han cerrado sus sesiones.`
        : `${args.count} intentos fallidos en ${args.windowMin} min desde ${args.kind === 'ip' ? 'la IP' : 'el email'} ${args.identifier}`;

    await this.notifyPanel(title, detail);
    await this.sendEmail(args, target);
    await this.chat.send(`🚨 ${title}\n${detail}`, 'security').catch((err: unknown) => {
      this.logger.warn(`Aviso de seguridad por chat: ${(err as Error).message}`);
    });
    this.logger.warn(`Alerta de fuerza bruta: ${args.kind}=${args.identifier} count=${args.count}`);
    return true;
  }

  private async touchesAdminPanel(args: AlertArgs): Promise<boolean> {
    const count = await this.admin.securityEvent.count({
      where: {
        occurredAt: { gte: new Date(Date.now() - args.windowMin * 60_000) },
        eventType: { in: [...ADMIN_FAILURE_EVENT_TYPES] },
        ...(args.kind === 'ip'
          ? { ipAddress: args.identifier }
          : { emailAttempted: args.identifier }),
      },
    });
    return count > 0;
  }

  /** Notificación del panel: de aquí sale también el push a los super admins. */
  private async notifyPanel(title: string, body: string): Promise<void> {
    try {
      await this.admin.superAdminNotification.create({
        data: { type: 'security.brute_force', title, body, link: '/admin/security-events' },
      });
    } catch (err) {
      this.logger.warn(`Aviso de seguridad en el panel: ${(err as Error).message}`);
    }
  }

  private async sendEmail(args: AlertArgs, target: string): Promise<void> {
    const kindLabel = args.kind === 'ip' ? 'IP' : 'EMAIL';
    const subject = `[TrasterOS] Posible brute-force: ${args.kind}=${args.identifier} (${args.count} en ${args.windowMin}min)${target}`;
    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const dashboardUrl = `${webBase}/admin/security-events`;

    const html = [
      '<!DOCTYPE html>',
      '<html><body style="font-family:Arial,Helvetica,sans-serif;color:#111;">',
      `<h2 style="color:#b91c1c;">Alerta de seguridad: posible fuerza bruta${target}</h2>`,
      `<p>Se han detectado <strong>${args.count}</strong> intentos de acceso fallidos en los últimos <strong>${args.windowMin} minutos</strong> desde:</p>`,
      '<ul>',
      `<li><strong>${kindLabel}</strong>: <code>${escapeHtml(args.identifier)}</code></li>`,
      `<li><strong>Fallos</strong>: ${args.count}</li>`,
      `<li><strong>Ventana</strong>: ${args.windowMin} minutos</li>`,
      '</ul>',
      `<p>Revisa el panel de seguridad: <a href="${dashboardUrl}">${dashboardUrl}</a></p>`,
      '<p style="color:#6b7280;font-size:12px;">Correo automático. El mismo email o IP se avisa una vez por ventana.</p>',
      '</body></html>',
    ].join('\n');

    const text = [
      `Alerta de seguridad: posible fuerza bruta${target}`,
      '',
      `Se han detectado ${args.count} intentos de acceso fallidos en los últimos ${args.windowMin} minutos.`,
      `${kindLabel}: ${args.identifier}`,
      '',
      `Revisa el panel: ${dashboardUrl}`,
    ].join('\n');

    try {
      await this.platformAlerts.emailAdmins({
        kind: 'security',
        subject,
        html,
        text,
        fallbackTo: this.config.get('SECURITY_ALERT_EMAIL', { infer: true }),
      });
    } catch (err) {
      this.logger.warn(`Aviso de seguridad por correo: ${(err as Error).message}`);
    }
  }

  /** Olvida las alertas ya lanzadas. Útil para tests. */
  async resetDedup(): Promise<void> {
    await this.admin.securityAlertState.deleteMany({});
  }
}

/** Escapado mínimo HTML para no romper el layout con identifiers raros. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

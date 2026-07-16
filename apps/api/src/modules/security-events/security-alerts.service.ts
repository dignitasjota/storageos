import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/providers/email-provider';

import type { Env } from '../../config/env.schema';

/** Tipo de identificador agregado en el scan. */
type AlertKind = 'email' | 'ip';

interface AlertArgs {
  kind: AlertKind;
  identifier: string;
  count: number;
  windowMin: number;
}

/**
 * Detecta intentos de brute-force agregando `security_events` recientes y
 * envia un email al super admin si supera el threshold configurado.
 *
 * Se ejecuta periodicamente (`SecurityAlertsCron`) o bajo demanda via el
 * endpoint `POST /admin/security-alerts/scan`. La logica es totalmente
 * stateless en BD: no creamos tabla nueva — un `Map` in-memory evita
 * mandar duplicados durante la misma ventana.
 *
 * Si `SECURITY_ALERT_EMAIL` no esta configurado, el scan es no-op (logs only).
 */
@Injectable()
export class SecurityAlertsService {
  private readonly logger = new Logger(SecurityAlertsService.name);

  /**
   * Dedup in-memory: `${kind}:${identifier}` -> timestamp de la ultima
   * alerta enviada. Se resetea al reiniciar el proceso (aceptable: si la
   * actividad maliciosa persiste tras un restart, mandamos otra alerta).
   */
  private readonly lastAlertedAt = new Map<string, number>();

  constructor(
    private readonly admin: PrismaAdminService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Escanea los `security_events` de los ultimos `WINDOW_MINUTES` minutos
   * y envia una alerta por cada email/IP que supere el threshold.
   *
   * Devuelve el numero de alertas efectivamente enviadas (descontando las
   * que se han suprimido por dedup).
   */
  async scanAndAlert(): Promise<{ alertsSent: number }> {
    const threshold = this.config.get('SECURITY_BRUTE_FORCE_THRESHOLD', { infer: true });
    const windowMin = this.config.get('SECURITY_BRUTE_FORCE_WINDOW_MINUTES', { infer: true });
    const alertEmail = this.config.get('SECURITY_ALERT_EMAIL', { infer: true });

    if (!alertEmail) {
      this.logger.debug(
        'SECURITY_ALERT_EMAIL no esta configurado; alertas de brute-force deshabilitadas',
      );
      return { alertsSent: 0 };
    }

    const cutoff = new Date(Date.now() - windowMin * 60_000);

    // Query 1: agrupacion por email con >= threshold fallos en la ventana.
    const emailGroups = await this.admin.securityEvent.groupBy({
      by: ['emailAttempted'],
      where: {
        occurredAt: { gte: cutoff },
        eventType: { in: ['login_failed_wrong_password', 'login_failed_email_not_found'] },
        emailAttempted: { not: null },
      },
      _count: { _all: true },
      having: { emailAttempted: { _count: { gte: threshold } } },
    });

    // Query 2: agrupacion por IP con >= threshold fallos en la ventana.
    // Incluimos tambien tenant_not_found porque indica scanning de slugs.
    const ipGroups = await this.admin.securityEvent.groupBy({
      by: ['ipAddress'],
      where: {
        occurredAt: { gte: cutoff },
        eventType: {
          in: [
            'login_failed_wrong_password',
            'login_failed_email_not_found',
            'login_failed_tenant_not_found',
          ],
        },
        ipAddress: { not: null },
      },
      _count: { _all: true },
      having: { ipAddress: { _count: { gte: threshold } } },
    });

    let alertsSent = 0;
    for (const group of emailGroups) {
      if (!group.emailAttempted) continue;
      const sent = await this.maybeSendAlert(alertEmail, {
        kind: 'email',
        identifier: group.emailAttempted,
        count: group._count._all,
        windowMin,
      });
      if (sent) alertsSent++;
    }
    for (const group of ipGroups) {
      if (!group.ipAddress) continue;
      const sent = await this.maybeSendAlert(alertEmail, {
        kind: 'ip',
        identifier: group.ipAddress,
        count: group._count._all,
        windowMin,
      });
      if (sent) alertsSent++;
    }

    return { alertsSent };
  }

  /**
   * Aplica dedup in-memory antes de enviar. Si la misma combinacion
   * `${kind}:${identifier}` ha sido alertada dentro de la ventana actual,
   * se ignora. Devuelve `true` si efectivamente se mando el email.
   */
  private async maybeSendAlert(to: string, args: AlertArgs): Promise<boolean> {
    const key = `${args.kind}:${args.identifier}`;
    const last = this.lastAlertedAt.get(key);
    const now = Date.now();
    const windowMs = args.windowMin * 60_000;
    if (last !== undefined && now - last < windowMs) {
      this.logger.debug(`Dedup: skip alerta para ${key} (ultima hace ${(now - last) / 1000}s)`);
      return false;
    }
    await this.sendEmailAlert(to, args);
    this.lastAlertedAt.set(key, now);
    return true;
  }

  /**
   * Envia un email simple HTML con el resumen. No usamos plantilla React
   * Email porque es un mensaje interno de admin — no necesita branding.
   */
  private async sendEmailAlert(to: string, args: AlertArgs): Promise<void> {
    const kindLabel = args.kind === 'email' ? 'EMAIL' : 'IP';
    const subject = `[TrasterOS] Posible brute-force: ${args.kind}=${args.identifier} (${args.count} en ${args.windowMin}min)`;
    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const dashboardUrl = `${webBase}/admin/security-events`;

    const html = [
      '<!DOCTYPE html>',
      '<html><body style="font-family:Arial,Helvetica,sans-serif;color:#111;">',
      '<h2 style="color:#b91c1c;">Alerta de seguridad: posible brute-force</h2>',
      `<p>Se han detectado <strong>${args.count}</strong> intentos de login fallidos en los ultimos <strong>${args.windowMin} minutos</strong> desde:</p>`,
      '<ul>',
      `<li><strong>${kindLabel}</strong>: <code>${escapeHtml(args.identifier)}</code></li>`,
      `<li><strong>Fallos</strong>: ${args.count}</li>`,
      `<li><strong>Ventana</strong>: ${args.windowMin} minutos</li>`,
      '</ul>',
      `<p>Revisa el panel de seguridad: <a href="${dashboardUrl}">${dashboardUrl}</a></p>`,
      '<p style="color:#6b7280;font-size:12px;">Este email se ha generado automaticamente. Las alertas se deduplican durante la misma ventana.</p>',
      '</body></html>',
    ].join('\n');

    const text = [
      'Alerta de seguridad: posible brute-force',
      '',
      `Se han detectado ${args.count} intentos de login fallidos en los ultimos ${args.windowMin} minutos.`,
      `${kindLabel}: ${args.identifier}`,
      '',
      `Revisa el panel: ${dashboardUrl}`,
    ].join('\n');

    await this.email.send({
      to,
      subject,
      html,
      text,
      tags: {
        category: 'security-alert',
        kind: args.kind,
      },
    });

    this.logger.warn(
      `Alerta brute-force enviada: ${args.kind}=${args.identifier} count=${args.count} window=${args.windowMin}min`,
    );
  }

  /**
   * Resetea el dedup in-memory. Util para tests.
   */
  resetDedup(): void {
    this.lastAlertedAt.clear();
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

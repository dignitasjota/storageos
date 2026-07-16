import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import type { Env } from '../../config/env.schema';
import type { TenantLifecycleRunResultDto } from '@storageos/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hitos del trial: cada uno se manda una vez, en su ventana de 1 día. */
const TRIAL_MILESTONES = [
  { type: 'trial_t7', days: 7 },
  { type: 'trial_t3', days: 3 },
  { type: 'trial_t1', days: 1 },
] as const;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderEmail(body: string): { html: string; text: string } {
  const safe = escapeHtml(body).replace(/\n/g, '<br>');
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;line-height:1.6">${safe}</div>`;
  return { html, text: body };
}

interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

/**
 * Emails automáticos de ciclo de vida al OWNER del tenant: bienvenida (alta),
 * recordatorios de trial por expirar (7/3/1 días) y aviso de pago fallido
 * (past_due). Los dispara un cron diario; cada tipo se manda UNA vez por tenant
 * (idempotencia en `tenant_lifecycle_emails`, UNIQUE tenant+type). El envío va
 * a la cola BullMQ `email` (el worker la procesa en prod). Config en el
 * singleton `platform_alert_settings` (reutilizado, junto a las alertas).
 */
@Injectable()
export class TenantLifecycleEmailsService {
  private readonly logger = new Logger(TenantLifecycleEmailsService.name);
  private readonly billingUrl: string;

  constructor(
    private readonly admin: PrismaAdminService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.billingUrl = `${config.get('WEB_BASE_URL', { infer: true })}/settings/saas-billing`;
  }

  /**
   * Evalúa las categorías activas y encola los emails pendientes. Idempotente:
   * solo actúa sobre tenants sin la fila del tipo correspondiente, y registra la
   * fila (UNIQUE tenant+type) antes de encolar. Si el singleton no tiene
   * `lifecycleEnabled`, es no-op.
   */
  async run(): Promise<TenantLifecycleRunResultDto> {
    const settings = await this.admin.platformAlertSettings.findFirst();
    const result: TenantLifecycleRunResultDto = { welcome: 0, trialReminders: 0, pastDue: 0 };
    if (!settings || !settings.lifecycleEnabled) return result;

    if (settings.sendWelcome) result.welcome = await this.runWelcome();
    if (settings.sendTrialReminders) result.trialReminders = await this.runTrialReminders();
    if (settings.sendPastDue) result.pastDue = await this.runPastDue();

    if (result.welcome + result.trialReminders + result.pastDue > 0) {
      this.logger.log(
        `tenant-lifecycle: encolados welcome=${result.welcome} trial=${result.trialReminders} pastDue=${result.pastDue}`,
      );
    }
    return result;
  }

  /** Bienvenida a tenants dados de alta en las últimas 48h, sin email previo. */
  private async runWelcome(): Promise<number> {
    const since = new Date(Date.now() - 2 * DAY_MS);
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        createdAt: { gte: since },
        tenantLifecycleEmails: { none: { type: 'welcome' } },
      },
      select: { id: true, name: true },
    });
    let count = 0;
    for (const t of tenants) {
      if (await this.dispatch(t.id, 'welcome', this.welcomeTemplate(t.name))) count += 1;
    }
    return count;
  }

  /** Recordatorios de trial en cada hito (7/3/1 días) con ventana de 1 día. */
  private async runTrialReminders(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const milestone of TRIAL_MILESTONES) {
      // trialEndsAt en [now + (days-1)d, now + days·d]: el cron diario captura
      // cada hito una sola vez conforme el fin de trial se acerca.
      const lower = new Date(now.getTime() + (milestone.days - 1) * DAY_MS);
      const upper = new Date(now.getTime() + milestone.days * DAY_MS);
      const tenants = await this.admin.tenant.findMany({
        where: {
          deletedAt: null,
          billingExempt: false,
          status: 'trial',
          trialEndsAt: { gte: lower, lte: upper },
          tenantLifecycleEmails: { none: { type: milestone.type } },
        },
        select: { id: true, name: true, trialEndsAt: true },
      });
      for (const t of tenants) {
        const tmpl = this.trialTemplate(t.name, milestone.days);
        if (await this.dispatch(t.id, milestone.type, tmpl)) count += 1;
      }
    }
    return count;
  }

  /** Aviso de pago fallido a suscripciones `past_due`, una vez por episodio. */
  private async runPastDue(): Promise<number> {
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        subscription: { status: 'past_due' },
        tenantLifecycleEmails: { none: { type: 'past_due' } },
      },
      select: { id: true, name: true },
    });
    let count = 0;
    for (const t of tenants) {
      if (await this.dispatch(t.id, 'past_due', this.pastDueTemplate(t.name))) count += 1;
    }
    return count;
  }

  /**
   * Encola el email a los destinatarios del tenant y registra la fila de
   * idempotencia. Decisión: si NO hay destinatarios (owner verificado o
   * billingEmail), NO registramos la fila → se reintentará cuando el tenant
   * tenga un owner verificado (no perdemos el email de bienvenida por un alta
   * sin verificar aún). Devuelve true si se encoló.
   */
  private async dispatch(tenantId: string, type: string, tmpl: EmailTemplate): Promise<boolean> {
    const recipients = await this.recipientsFor(tenantId);
    if (recipients.length === 0) return false;

    // Registramos la fila ANTES de encolar: si otra réplica ya la creó, el
    // UNIQUE (tenant, type) lanza P2002 y no duplicamos el envío.
    try {
      await this.admin.tenantLifecycleEmail.create({ data: { tenantId, type } });
    } catch {
      // Ya enviado por otra réplica/ejecución concurrente → no reencolar.
      return false;
    }

    await this.emailQueue.addBulk(
      recipients.map((to) => ({
        name: JOB_EMAIL_SEND,
        data: { to, subject: tmpl.subject, html: tmpl.html, text: tmpl.text },
      })),
    );
    return true;
  }

  /** Emails de destino de un tenant: owners verificados activos o billingEmail. */
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

  // --- Plantillas (español, tono cordial de operador SaaS) ---

  private welcomeTemplate(tenantName: string): EmailTemplate {
    const body = [
      `¡Bienvenido a TrasterOS, ${tenantName}!`,
      '',
      'Gracias por darte de alta. Ya puedes empezar a gestionar tus locales, trasteros,',
      'contratos y facturación desde el panel.',
      '',
      'Para sacarle el máximo partido, te recomendamos completar la configuración inicial',
      '(datos de tu empresa, primer local y trasteros) y revisar tu plan de suscripción:',
      '',
      this.billingUrl,
      '',
      'Si necesitas ayuda, responde a este correo o abre un ticket de soporte desde el panel.',
      '',
      'Un saludo,',
      'El equipo de TrasterOS',
    ].join('\n');
    return { subject: '¡Bienvenido a TrasterOS!', ...renderEmail(body) };
  }

  private trialTemplate(tenantName: string, days: number): EmailTemplate {
    const daysLabel = days === 1 ? '1 día' : `${days} días`;
    const body = [
      `Hola, ${tenantName}:`,
      '',
      `Tu periodo de prueba termina en ${daysLabel}. Para no perder el acceso a tu cuenta`,
      'ni a tus datos, suscríbete a un plan antes de que finalice:',
      '',
      this.billingUrl,
      '',
      'Elige el plan que mejor se ajuste a tu operativa; puedes cambiarlo en cualquier momento.',
      '',
      '¿Dudas sobre qué plan te conviene? Responde a este correo y te ayudamos.',
      '',
      'Un saludo,',
      'El equipo de TrasterOS',
    ].join('\n');
    return {
      subject: `Tu prueba de TrasterOS termina en ${daysLabel}`,
      ...renderEmail(body),
    };
  }

  private pastDueTemplate(tenantName: string): EmailTemplate {
    const body = [
      `Hola, ${tenantName}:`,
      '',
      'No hemos podido cobrar la cuota de tu suscripción a TrasterOS. Para mantener tu cuenta',
      'activa y evitar la suspensión del servicio, por favor regulariza el pago:',
      '',
      this.billingUrl,
      '',
      'Desde ahí puedes actualizar tu método de pago o completar el pago pendiente.',
      '',
      'Si crees que se trata de un error o necesitas ayuda, responde a este correo.',
      '',
      'Un saludo,',
      'El equipo de TrasterOS',
    ].join('\n');
    return { subject: 'No hemos podido cobrar tu suscripción a TrasterOS', ...renderEmail(body) };
  }
}

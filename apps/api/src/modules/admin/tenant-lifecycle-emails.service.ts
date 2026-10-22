import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SUSPENSION_NOTICE_DAYS,
  SUSPENSION_WEB_OFFLINE_DAYS,
  suspensionDays,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import type { Env } from '../../config/env.schema';
import type { AdminQuoteDto, TenantLifecycleRunResultDto } from '@storageos/shared';

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

interface Counts {
  facilities: number;
  customers: number;
  invoices: number;
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
    private readonly audit: AuditService,
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
    const emailsOn = !!settings?.lifecycleEnabled;
    const result: TenantLifecycleRunResultDto = {
      welcome: 0,
      trialReminders: 0,
      pastDue: 0,
      // La prueba vence aunque los correos estén apagados.
      trialsEnded: await this.expireTrials(emailsOn && !!settings?.sendTrialReminders),
      suspensionNotices: 0,
      activationNudges: 0,
    };
    // Avisos de suspensión: siempre (son los que hacen que pague), aunque el
    // resto de correos de ciclo de vida estén apagados.
    result.suspensionNotices = await this.runSuspensionNotices();
    if (!settings || !emailsOn) return result;

    if (settings.sendWelcome) result.welcome = await this.runWelcome();
    if (settings.sendTrialReminders) result.trialReminders = await this.runTrialReminders();
    if (settings.sendPastDue) result.pastDue = await this.runPastDue();
    if (settings.sendActivation) result.activationNudges = await this.runActivationNudges();

    if (result.welcome + result.trialReminders + result.pastDue > 0) {
      this.logger.log(
        `tenant-lifecycle: encolados welcome=${result.welcome} trial=${result.trialReminders} pastDue=${result.pastDue}`,
      );
    }
    return result;
  }

  /**
   * Pruebas vencidas sin pagar: pasan al plan Free (como «Finalizar prueba» del
   * panel admin). El tenant sigue entrando y conserva sus datos, pero pierde las
   * funciones de pago hasta que contrate un plan. Una prueba que ya pagó (su
   * suscripción está activa) solo sale de `trial`.
   */
  async expireTrials(sendEmail: boolean, now = new Date()): Promise<number> {
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        status: 'trial',
        trialEndsAt: { lt: now },
      },
      select: {
        id: true,
        name: true,
        subscription: { select: { status: true, plan: { select: { slug: true } } } },
      },
      take: 500,
    });
    if (tenants.length === 0) return 0;
    const freePlan = await this.admin.subscriptionPlan.findFirst({ where: { slug: 'free' } });
    let ended = 0;
    for (const t of tenants) {
      const paid = t.subscription?.status === 'active';
      // Solo la primera ejecución cambia el estado (otra réplica ve count 0).
      const { count } = await this.admin.tenant.updateMany({
        where: { id: t.id, status: 'trial' },
        data: { status: 'active', trialEndsAt: null },
      });
      if (count === 0) continue;
      if (!paid && freePlan) {
        await this.admin.tenantSubscription.updateMany({
          where: { tenantId: t.id },
          data: { planId: freePlan.id, status: 'active' },
        });
      }
      ended += 1;
      await this.audit
        .write({
          tenantId: t.id,
          userId: null,
          action: 'tenant.trial_expired',
          entityType: 'Tenant',
          entityId: t.id,
          changes: {
            previousPlan: t.subscription?.plan.slug ?? null,
            newPlan: paid ? (t.subscription?.plan.slug ?? null) : 'free',
          },
          ipAddress: null,
          userAgent: null,
        })
        .catch(() => undefined);
      if (sendEmail && !paid) {
        const limits = await this.freePlanLimitsNote(t.id, 'ended').catch(() => []);
        await this.dispatch(t.id, 'trial_ended', this.trialEndedTemplate(t.name, limits)).catch(
          () => false,
        );
      }
    }
    if (ended > 0) this.logger.log(`tenant-lifecycle: ${ended} pruebas vencidas pasan a Free`);
    return ended;
  }

  /**
   * Tenant suspendido: avisos al propietario el día de la suspensión, a los 7 y
   * a los 14 días (el último, que mañana deja de verse su web). Uno por hito y
   * episodio (`suspension_d<días>:<fecha de suspensión>`); si el cron no corrió
   * un día, solo se manda el hito más reciente alcanzado.
   */
  async runSuspensionNotices(now = new Date()): Promise<number> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, billingExempt: false, status: 'suspended' },
      select: { id: true, name: true, canceledAt: true, updatedAt: true },
      take: 500,
    });
    let count = 0;
    for (const t of tenants) {
      const since = t.canceledAt ?? t.updatedAt;
      const days = suspensionDays(since, now);
      const milestone = [...SUSPENSION_NOTICE_DAYS].reverse().find((d) => days >= d);
      if (milestone === undefined) continue;
      const type = `suspension_d${milestone}:${since.toISOString().slice(0, 10)}`;
      const sent = await this.admin.tenantLifecycleEmail.findUnique({
        where: { tenantId_type: { tenantId: t.id, type } },
        select: { id: true },
      });
      if (sent) continue;
      const held = await this.heldAmount(t.id);
      if (await this.dispatch(t.id, type, this.suspensionTemplate(t.name, milestone, held))) {
        count += 1;
      }
    }
    return count;
  }

  /** Lo que sus inquilinos deben y no se les está cobrando (€). */
  private async heldAmount(tenantId: string): Promise<number> {
    const agg = await this.admin.invoice.aggregate({
      where: {
        tenantId,
        kind: 'invoice',
        deletedAt: null,
        status: { in: ['issued', 'overdue'] },
        total: { gt: 0 },
      },
      _sum: { total: true, amountPaid: true, amountRefunded: true },
    });
    const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
    return (
      Math.max(
        0,
        cents(agg._sum.total) - cents(agg._sum.amountPaid) - cents(agg._sum.amountRefunded),
      ) / 100
    );
  }

  private suspensionTemplate(tenantName: string, day: number, held: number): EmailTemplate {
    const money = held.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
    const offlineIn = SUSPENSION_WEB_OFFLINE_DAYS - day;
    const subject =
      day === 0
        ? `Tu cuenta de TrasterOS está suspendida (${tenantName})`
        : day >= SUSPENSION_WEB_OFFLINE_DAYS - 1
          ? `Mañana tu web dejará de verse (${tenantName})`
          : `Tu cuenta sigue suspendida: ${money} sin cobrar a tus inquilinos`;
    const lines = [
      `Hola,`,
      ``,
      day === 0
        ? `La cuenta de ${tenantName} en TrasterOS se ha suspendido por un pago pendiente de la suscripción.`
        : `La cuenta de ${tenantName} lleva ${day} días suspendida por un pago pendiente de la suscripción.`,
      ``,
      `Mientras no se regularice:`,
      `• El panel está en solo lectura: puedes consultar, pero no trabajar.`,
      held > 0
        ? `• No se cobra a tus inquilinos: tienes ${money} retenidos.`
        : `• No se cobra a tus inquilinos.`,
      `• Los correos a tus inquilinos (facturas, avisos) están en espera.`,
      `• Tus inquilinos no pueden entrar a su área de clientes ni reservar online.`,
      offlineIn > 1
        ? `• Dentro de ${offlineIn} días tu web pública dejará de verse.`
        : offlineIn === 1
          ? `• Mañana tu web pública dejará de verse.`
          : `• Tu web pública ya no se ve.`,
      ``,
      `Tus inquilinos siguen pudiendo entrar a sus trasteros: el acceso no se corta.`,
      ``,
      `Al pagar, todo vuelve solo: se reactiva el panel, se cobran los recibos retenidos y salen los correos en espera.`,
      ``,
      `Pagar y reactivar: ${this.billingUrl}`,
      ``,
      `El equipo de TrasterOS`,
    ];
    return { subject, ...renderEmail(lines.join('\n')) };
  }

  /**
   * Prueba gratis de un extra: aviso de que quedan pocos días o de que ha
   * terminado, con el enlace para contratarlo. Uno por prueba y momento
   * (`type` lo deduplica).
   */
  sendFeatureTrialNotice(
    tenantId: string,
    type: string,
    args: { tenantName: string; addonName: string; expiresAt: Date; ended: boolean },
  ): Promise<boolean> {
    const date = args.expiresAt.toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'long',
      timeZone: 'Europe/Madrid',
    });
    const subject = args.ended
      ? `Tu prueba de ${args.addonName} ha terminado`
      : `Tu prueba de ${args.addonName} termina el ${date}`;
    const body = [
      'Hola,',
      '',
      args.ended
        ? `La prueba gratis de ${args.addonName} en ${args.tenantName} ha terminado y la función se ha desactivado. Tus datos siguen ahí.`
        : `La prueba gratis de ${args.addonName} en ${args.tenantName} termina el ${date}.`,
      '',
      args.ended
        ? 'Si quieres seguir usándola, contrátala desde Configuración → Suscripción y se activa al momento.'
        : 'Para no perderla, contrátala antes desde Configuración → Suscripción; se mantiene sin cortes.',
      '',
      `Contratar: ${this.billingUrl}`,
      '',
      'El equipo de TrasterOS',
    ].join('\n');
    return this.dispatch(tenantId, type, { subject, ...renderEmail(body) });
  }

  /**
   * Propuesta de un extra: qué es, precio, prueba gratis si se ha activado y
   * enlace para contratarlo. Devuelve a cuántos propietarios se envía.
   */
  async sendAddonOffer(
    tenantId: string,
    args: {
      tenantName: string;
      addonName: string;
      description: string | null;
      priceMonthly: number;
      pricesIncludeVat: boolean;
      message: string | null;
      trialUntil: Date | null;
    },
  ): Promise<number> {
    const recipients = await this.recipientsFor(tenantId);
    if (recipients.length === 0) return 0;
    const price = `${args.priceMonthly.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}/mes${
      args.pricesIncludeVat ? ' (IVA incluido)' : ' + IVA'
    }`;
    const until = args.trialUntil?.toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'long',
      timeZone: 'Europe/Madrid',
    });
    const body = [
      'Hola,',
      '',
      ...(args.message ? [args.message, ''] : []),
      `Te proponemos ${args.addonName} para ${args.tenantName}.`,
      ...(args.description ? ['', args.description] : []),
      '',
      `Precio: ${price}. Se activa al momento y lo puedes cancelar cuando quieras.`,
      ...(until
        ? ['', `Te lo hemos activado gratis hasta el ${until} para que lo pruebes sin compromiso.`]
        : []),
      '',
      `Contratar: ${this.billingUrl}`,
      '',
      'Si tienes dudas, responde a este correo.',
      '',
      'El equipo de TrasterOS',
    ].join('\n');
    const sent = await this.dispatch(tenantId, `addon_offer:${Date.now()}`, {
      subject: until
        ? `Prueba gratis de ${args.addonName} hasta el ${until}`
        : `${args.addonName} para ${args.tenantName}`,
      ...renderEmail(body),
    });
    return sent ? recipients.length : 0;
  }

  /** Propuesta de cuota (plan + extras) con su desglose y el enlace para contratar. */
  async sendQuoteOffer(
    tenantId: string,
    args: { tenantName: string; quote: AdminQuoteDto; message: string | null },
  ): Promise<number> {
    const recipients = await this.recipientsFor(tenantId);
    if (recipients.length === 0) return 0;
    const q = args.quote;
    const money = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
    const period = q.cycle === 'yearly' ? 'al año' : 'al mes';
    const body = [
      'Hola,',
      '',
      ...(args.message ? [args.message, ''] : []),
      `Esta es la propuesta para ${args.tenantName}:`,
      '',
      ...q.lines.map((l) => `• ${l.label}: ${money(l.amount)}`),
      ...(q.discount > 0 ? [`• Descuento (${q.couponCode}): -${money(q.discount)}`] : []),
      '',
      `Base: ${money(q.base)} · IVA (${q.taxRate} %): ${money(q.vat)}`,
      `Total: ${money(q.total)} ${period}${q.cycle === 'yearly' ? ` (${money(q.monthlyEquivalent)} al mes)` : ''}`,
      ...(q.yearlySaving ? [`Ahorras ${money(q.yearlySaving)} frente a pagar mes a mes.`] : []),
      '',
      `Contratar: ${this.billingUrl}`,
      '',
      'Si tienes dudas, responde a este correo.',
      '',
      'El equipo de TrasterOS',
    ].join('\n');
    const sent = await this.dispatch(tenantId, `quote_offer:${Date.now()}`, {
      subject: `Tu propuesta de TrasterOS: ${money(q.total)} ${period}`,
      ...renderEmail(body),
    });
    return sent ? recipients.length : 0;
  }

  /**
   * Ayuda para arrancar según el uso de la prueba: al día 3 sin locales, al 7
   * sin inquilinos y al 12 sin facturas, un correo con los pasos y la oferta
   * de ayuda. El del día 12 deja además un seguimiento al super admin para
   * llamarle. Uno por tipo y tenant.
   */
  async runActivationNudges(now = new Date()): Promise<number> {
    const day = 86_400_000;
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        status: 'trial',
        createdAt: { lte: new Date(now.getTime() - 3 * day) },
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
        tenantLifecycleEmails: { select: { type: true } },
        _count: {
          select: {
            facilities: { where: { deletedAt: null } },
            customers: { where: { deletedAt: null } },
            invoices: {
              where: {
                deletedAt: null,
                kind: 'invoice',
                status: { in: ['issued', 'paid', 'overdue'] },
              },
            },
          },
        },
      },
      take: 500,
    });
    const steps = [
      { type: 'activation_facility', after: 3, missing: (c: Counts) => c.facilities === 0 },
      { type: 'activation_customer', after: 7, missing: (c: Counts) => c.customers === 0 },
      { type: 'activation_invoice', after: 12, missing: (c: Counts) => c.invoices === 0 },
    ] as const;
    let count = 0;
    for (const t of tenants) {
      const days = Math.floor((now.getTime() - t.createdAt.getTime()) / day);
      const sent = new Set(t.tenantLifecycleEmails.map((e) => e.type));
      // Solo el paso más avanzado que toca (si va con retraso no le llegan tres seguidos).
      const step = [...steps].reverse().find((s) => days >= s.after && s.missing(t._count));
      if (!step || sent.has(step.type)) continue;
      if (await this.dispatch(t.id, step.type, this.activationTemplate(t.name, step.type))) {
        count += 1;
        if (step.type === 'activation_invoice') {
          await this.admin.tenantFollowup.create({
            data: {
              tenantId: t.id,
              superAdminId: null,
              title: 'Llamar: lleva 12 días de prueba sin facturar',
              dueDate: new Date(now.toISOString().slice(0, 10)),
            },
          });
        }
      }
    }
    return count;
  }

  private activationTemplate(tenantName: string, type: string): EmailTemplate {
    const base = this.billingUrl.replace('/settings/saas-billing', '');
    const content: Record<string, { subject: string; lines: string[] }> = {
      activation_facility: {
        subject: 'Da de alta tu primer local en TrasterOS',
        lines: [
          `Aún no has creado ningún local en ${tenantName}. Es el primer paso y se hace en un par de minutos:`,
          '',
          '1. Crea el local (nombre, dirección y horario).',
          '2. Añade los tipos de trastero con sus precios.',
          '3. Da de alta los trasteros (o impórtalos desde un Excel).',
          '',
          `Empezar: ${base}/facilities`,
        ],
      },
      activation_customer: {
        subject: 'Trae a tus inquilinos a TrasterOS',
        lines: [
          `Ya tienes ${tenantName} montado; ahora faltan tus inquilinos.`,
          '',
          'Puedes darlos de alta uno a uno o importarlos todos de golpe desde un Excel o CSV (inquilinos, trasteros y contratos), sin volver a escribirlos.',
          '',
          `Importar: ${base}/customers/import`,
        ],
      },
      activation_invoice: {
        subject: '¿Te ayudamos a emitir tu primera factura?',
        lines: [
          `Llevas casi dos semanas de prueba en ${tenantName} y todavía no has emitido ninguna factura.`,
          '',
          'Si quieres, te ayudamos a dejarlo listo en una llamada: series de facturación, cobro automático y la facturación mensual de tus contratos. Solo tienes que responder a este correo.',
          '',
          `Facturas: ${base}/invoices`,
        ],
      },
    };
    const c = content[type]!;
    const body = ['Hola,', '', ...c.lines, '', 'Un saludo,', 'El equipo de TrasterOS'].join('\n');
    return { subject: c.subject, ...renderEmail(body) };
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
      select: { id: true, name: true, slug: true },
    });
    let count = 0;
    for (const t of tenants) {
      if (await this.dispatch(t.id, 'welcome', this.welcomeTemplate(t.name, t.slug))) count += 1;
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
        const limits = await this.freePlanLimitsNote(t.id, 'ending').catch(() => []);
        const tmpl = this.trialTemplate(t.name, milestone.days, limits);
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
        data: {
          to,
          kind: lifecycleKind(type),
          subject: tmpl.subject,
          html: tmpl.html,
          text: tmpl.text,
        },
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

  /**
   * Qué pasa con lo que ya tiene al pasar al plan Gratis: si supera alguno de
   * sus límites, lo conserva todo pero no puede crear más. Vacío si cabe.
   */
  private async freePlanLimitsNote(tenantId: string, when: 'ending' | 'ended'): Promise<string[]> {
    const [plan, units, facilities, users] = await Promise.all([
      this.admin.subscriptionPlan.findUnique({
        where: { slug: 'free' },
        select: { maxUnits: true, maxFacilities: true, maxUsers: true },
      }),
      this.admin.unit.count({ where: { tenantId } }),
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
      this.admin.user.count({ where: { tenantId, isActive: true } }),
    ]);
    if (!plan) return [];
    const over = [
      { have: units, max: plan.maxUnits, one: 'trastero', many: 'trasteros' },
      { have: facilities, max: plan.maxFacilities, one: 'local', many: 'locales' },
      { have: users, max: plan.maxUsers, one: 'usuario', many: 'usuarios' },
    ].filter((x) => x.max != null && x.have > x.max);
    if (over.length === 0) return [];
    const n = (v: number, one: string, many: string) => `${v} ${v === 1 ? one : many}`;
    const have = over.map((x) => n(x.have, x.one, x.many)).join(', ');
    const allowed = over.map((x) => n(x.max!, x.one, x.many)).join(', ');
    return [
      `${when === 'ending' ? 'Ahora tienes' : 'Tienes'} ${have}, y el plan Gratis permite ${allowed}.`,
      when === 'ending'
        ? 'Si no eliges un plan, lo conservarás todo, pero no podrás dar de alta más hasta contratarlo.'
        : 'Lo conservas todo, pero no podrás dar de alta más hasta que contrates un plan.',
    ];
  }

  private welcomeTemplate(tenantName: string, slug: string): EmailTemplate {
    const base = this.billingUrl.replace('/settings/saas-billing', '');
    const body = [
      `¡Bienvenido a TrasterOS, ${tenantName}!`,
      '',
      'Gracias por darte de alta. Para entrar al panel te pediremos el identificador',
      `de tu empresa: ${slug}`,
      '',
      'En el Resumen del panel tienes los primeros pasos para empezar a operar:',
      'tu local, los tipos de trastero con sus precios, los trasteros (o impórtalos',
      'desde un Excel), los datos de tu empresa y cómo te pagan tus inquilinos.',
      '',
      `Empezar: ${base}/dashboard`,
      '',
      `Tu web pública ya está activa: ${base}/s/${slug}`,
      '',
      'Si necesitas ayuda, responde a este correo o abre un ticket de soporte desde el panel.',
      '',
      'Un saludo,',
      'El equipo de TrasterOS',
    ].join('\n');
    return { subject: '¡Bienvenido a TrasterOS!', ...renderEmail(body) };
  }

  private trialTemplate(tenantName: string, days: number, limits: string[] = []): EmailTemplate {
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
      ...(limits.length > 0 ? ['', ...limits] : []),
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

  private trialEndedTemplate(tenantName: string, limits: string[] = []): EmailTemplate {
    const body = [
      `Hola, ${tenantName}:`,
      '',
      'Tu periodo de prueba de TrasterOS ha terminado y tu cuenta ha pasado al plan gratuito.',
      'Tus datos siguen ahí y puedes seguir entrando, pero las funciones de pago quedan',
      'desactivadas hasta que contrates un plan:',
      ...(limits.length > 0 ? ['', ...limits] : []),
      '',
      this.billingUrl,
      '',
      '¿Necesitas más tiempo para probar? Responde a este correo y lo vemos.',
      '',
      'Un saludo,',
      'El equipo de TrasterOS',
    ].join('\n');
    return { subject: 'Tu prueba de TrasterOS ha terminado', ...renderEmail(body) };
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

/** Correo de la plataforma de cada aviso del ciclo de vida (remitente y `{tipo}`). */
function lifecycleKind(
  type: string,
): 'welcome' | 'trial_ending' | 'payment_pending' | 'admin_message' {
  if (type.startsWith('addon_offer') || type.startsWith('quote_offer')) return 'admin_message';
  if (type.startsWith('activation_')) return 'welcome';
  if (type === 'welcome') return 'welcome';
  if (type === 'past_due') return 'payment_pending';
  if (type.startsWith('feature_trial')) return 'trial_ending';
  return 'trial_ending';
}

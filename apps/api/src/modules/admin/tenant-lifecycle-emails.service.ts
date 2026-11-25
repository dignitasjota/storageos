import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  BASIC_PLAN_SLUG,
  EXPIRED_READ_ONLY_DAYS,
  EXTRA_UNITS_ADDON_SLUG,
  extraUnitsFor,
  SUSPENSION_NOTICE_DAYS,
  SUSPENSION_WEB_OFFLINE_DAYS,
  suspensionDays,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { formatDateLong, formatEur, todayInTimezone } from '../../common/format';
import { platformUnsubscribeFooter } from '../../common/marketing/platform-unsubscribe';
import { unsubscribeKey } from '../../common/marketing/unsubscribe-token';
import { tenantReadiness } from '../../common/tenant-readiness';
import { AuditService } from '../auth/audit.service';
import { AuthService, TENANT_OWNER_VERIFIED } from '../auth/auth.service';
import { billableUnits } from '../billing-saas/billable-units';
import { amountToCharge, platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { PlatformEmailTemplatesService } from './platform-email-templates.service';

import type { Env } from '../../config/env.schema';
import type { AdminQuoteDto, TenantLifecycleRunResultDto } from '@storageos/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Días de aviso antes de pasar del plan gratuito a Basic. */
const FREE_PLAN_NOTICE_DAYS = 30;

/** Días tras el registro a los que se borra una cuenta que nunca se activó. */
const UNVERIFIED_PURGE_DAYS = 30;

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

/** Remitente de un correo de la prueba: el comercial que lleva la cuenta. */
export interface EmailSenderOverride {
  fromName: string;
  replyTo: { email: string; name?: string };
  signature?: string;
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
  private readonly webBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly unsubscribeKey: Buffer;

  constructor(
    private readonly admin: PrismaAdminService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
    config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly templates: PlatformEmailTemplatesService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
  ) {
    this.billingUrl = `${config.get('WEB_BASE_URL', { infer: true })}/settings/saas-billing`;
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.apiBaseUrl = config.get('API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.unsubscribeKey = unsubscribeKey(config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
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
      // El paso del plan gratuito a Basic va siempre (el aviso es lo que da el plazo).
      freePlanMoves: await this.runFreePlanTransition(),
      // Y la suspensión de quien lleva 30 días en solo lectura sin pagar.
      readOnlySuspended: await this.suspendLongReadOnly(),
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
   * Pruebas vencidas sin pagar: la cuenta pasa a solo lectura (suscripción
   * `expired`, mismo plan) hasta que elija cómo pagar; sus inquilinos y su web
   * siguen funcionando. Una prueba que ya pagó (su suscripción está activa) solo
   * sale de `trial`.
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
        subscription: {
          select: {
            status: true,
            billingMode: true,
            plan: { select: { slug: true, name: true } },
          },
        },
      },
      take: 500,
    });
    let ended = 0;
    for (const t of tenants) {
      // Ya paga (o el cobro de Stripe está en curso con su propio impago), o ya
      // eligió cómo pagar (domiciliación o tarjeta guardada): no pasa a solo
      // lectura, el cobro sale solo.
      const paid = t.subscription?.status === 'active' || t.subscription?.status === 'past_due';
      const willCharge =
        t.subscription?.billingMode === 'sepa' || t.subscription?.billingMode === 'redsys';
      // Solo la primera ejecución cambia el estado (otra réplica ve count 0), y
      // no si alguien le amplió la prueba entretanto.
      const { count } = await this.admin.tenant.updateMany({
        where: { id: t.id, status: 'trial', trialEndsAt: { lt: now } },
        data: { status: 'active', trialEndsAt: null },
      });
      if (count === 0) continue;
      if (!paid) {
        await this.admin.tenantSubscription.updateMany({
          where: { tenantId: t.id, status: { notIn: ['active', 'past_due'] } },
          data: { status: willCharge ? 'active' : 'expired' },
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
          changes: { plan: t.subscription?.plan.slug ?? null, readOnly: !paid && !willCharge },
          ipAddress: null,
          userAgent: null,
        })
        .catch(() => undefined);
      if (!paid && !willCharge) {
        await this.notifications
          .create(t.id, {
            type: 'billing.trial_ended',
            title: 'Tu prueba ha terminado',
            body: 'Tu cuenta está en solo lectura hasta que elijas cómo pagar.',
            link: '/settings/saas-billing',
          })
          .catch(() => undefined);
      }
      if (sendEmail && !paid && !willCharge) {
        const quote = await this.monthlyQuote(t.id).catch(() => null);
        await this.dispatch(
          t.id,
          'trial_ended',
          await this.templates.render('trial_ended', {
            empresa: t.name,
            plan: t.subscription?.plan.name ?? '',
            importe: quote?.label ?? '',
            enlace_pago: this.billingUrl,
          }),
        ).catch(() => false);
      }
    }
    if (ended > 0) this.logger.log(`tenant-lifecycle: ${ended} pruebas vencidas`);
    return ended;
  }

  /**
   * Fin del plan gratuito: a cada cuenta se le avisa una vez con 30 días y ese
   * día pasa a Basic. Si para entonces no ha elegido cómo pagar, queda en solo
   * lectura (como una prueba vencida) hasta que pague.
   */
  async runFreePlanTransition(now = new Date()): Promise<number> {
    const [free, basic] = await Promise.all([
      this.admin.subscriptionPlan.findUnique({ where: { slug: 'free' }, select: { id: true } }),
      this.admin.subscriptionPlan.findUnique({
        where: { slug: BASIC_PLAN_SLUG },
        select: { id: true, name: true, isActive: true },
      }),
    ]);
    if (!free || !basic?.isActive) return 0;
    // Quien ya salió del plan gratuito no conserva la fecha del paso.
    await this.admin.tenant.updateMany({
      where: { freePlanEndsAt: { not: null }, subscription: { planId: { not: free.id } } },
      data: { freePlanEndsAt: null },
    });
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        status: { in: ['active', 'trial'] },
        subscription: { planId: free.id },
      },
      select: { id: true, name: true, freePlanEndsAt: true },
      take: 500,
    });
    let moved = 0;
    for (const t of tenants) {
      try {
        if (!t.freePlanEndsAt) {
          const endsAt = new Date(now.getTime() + FREE_PLAN_NOTICE_DAYS * DAY_MS);
          const { count } = await this.admin.tenant.updateMany({
            where: { id: t.id, freePlanEndsAt: null },
            data: { freePlanEndsAt: endsAt },
          });
          if (count === 0) continue;
          const [units, quote] = await Promise.all([
            billableUnits(this.admin, t.id),
            this.monthlyQuote(t.id, BASIC_PLAN_SLUG),
          ]);
          const fecha = formatDateLong(endsAt);
          await this.notifications
            .create(t.id, {
              type: 'billing.free_plan_ending',
              title: `El ${fecha} tu cuenta pasa al plan Basic`,
              body: `Serán ${quote.label} al mes, IVA incluido. Elige cómo pagar antes para seguir sin cortes.`,
              link: '/settings/saas-billing',
            })
            .catch(() => undefined);
          await this.dispatch(
            t.id,
            'free_plan_notice',
            await this.templates.render('free_plan_notice', {
              empresa: t.name,
              fecha,
              trasteros: String(units),
              importe: quote.label,
              enlace_pago: this.billingUrl,
            }),
          ).catch(() => false);
          moved += 1;
          continue;
        }
        if (t.freePlanEndsAt > now) continue;
        // Ya toca: pasa a Basic y, sin pagar, queda en solo lectura.
        const { count } = await this.admin.tenantSubscription.updateMany({
          where: { tenantId: t.id, planId: free.id },
          data: {
            planId: basic.id,
            status: 'expired',
            currentPeriodStart: now,
            currentPeriodEnd: now,
          },
        });
        if (count === 0) continue;
        await this.admin.tenant.update({
          where: { id: t.id },
          data: { freePlanEndsAt: null, status: 'active', trialEndsAt: null },
        });
        const quote = await this.monthlyQuote(t.id);
        await this.audit
          .write({
            tenantId: t.id,
            userId: null,
            action: 'tenant.free_plan_ended',
            entityType: 'Tenant',
            entityId: t.id,
            changes: { previousPlan: 'free', newPlan: BASIC_PLAN_SLUG },
            ipAddress: null,
            userAgent: null,
          })
          .catch(() => undefined);
        await this.notifications
          .create(t.id, {
            type: 'billing.free_plan_ended',
            title: 'Tu cuenta ha pasado al plan Basic',
            body: 'Está en solo lectura hasta que elijas cómo pagar.',
            link: '/settings/saas-billing',
          })
          .catch(() => undefined);
        await this.dispatch(
          t.id,
          'free_plan_ended',
          await this.templates.render('free_plan_ended', {
            empresa: t.name,
            importe: quote.label,
            enlace_pago: this.billingUrl,
          }),
        ).catch(() => false);
        moved += 1;
      } catch (err) {
        this.logger.warn(`tenant-lifecycle: fin del plan gratuito de ${t.id}: ${String(err)}`);
      }
    }
    return moved;
  }

  /**
   * Solo lectura sin pagar durante 30 días (desde el fin de la prueba o del
   * plan gratuito): la cuenta se suspende como un impago (su web acaba
   * cerrándose y se retienen los cobros a sus inquilinos) hasta que pague.
   */
  async suspendLongReadOnly(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - EXPIRED_READ_ONLY_DAYS * DAY_MS);
    const subs = await this.admin.tenantSubscription.findMany({
      where: {
        status: 'expired',
        currentPeriodEnd: { lt: cutoff },
        tenant: { status: 'active', deletedAt: null, billingExempt: false },
      },
      select: { tenantId: true },
      take: 500,
    });
    let suspended = 0;
    for (const s of subs) {
      const { count } = await this.admin.tenant.updateMany({
        where: { id: s.tenantId, status: 'active', deletedAt: null },
        data: { status: 'suspended', churnReason: 'nonpayment', canceledAt: now },
      });
      if (count === 0) continue;
      suspended += 1;
      await this.audit
        .write({
          tenantId: s.tenantId,
          userId: null,
          action: 'tenant.read_only_suspended',
          entityType: 'Tenant',
          entityId: s.tenantId,
          changes: { days: EXPIRED_READ_ONLY_DAYS },
          ipAddress: null,
          userAgent: null,
        })
        .catch(() => undefined);
    }
    if (suspended > 0) {
      this.logger.log(`tenant-lifecycle: ${suspended} cuentas en solo lectura suspendidas`);
    }
    return suspended;
  }

  /**
   * Lo que pagaría al mes con lo que tiene hoy: el plan (el suyo u otro), los
   * trasteros de más si el plan va por trastero y sus extras. Con el IVA como
   * se cobra.
   */
  async monthlyQuote(
    tenantId: string,
    planSlug?: string,
  ): Promise<{ amount: number; label: string }> {
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      select: { plan: { select: { slug: true } } },
    });
    const slug = planSlug ?? sub?.plan.slug;
    const [plan, units, addons, unitAddon, pricing] = await Promise.all([
      slug
        ? this.admin.subscriptionPlan.findUnique({
            where: { slug },
            select: { priceMonthly: true, includedUnits: true },
          })
        : null,
      billableUnits(this.admin, tenantId),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId, suspendedAt: null, addon: { isSystem: false } },
        select: { priceMonthly: true, quantity: true, addon: { select: { planSlugs: true } } },
      }),
      this.admin.subscriptionAddon.findUnique({
        where: { slug: EXTRA_UNITS_ADDON_SLUG },
        select: { priceMonthly: true },
      }),
      platformPricing(this.admin),
    ]);
    let list = Number(plan?.priceMonthly ?? 0);
    if (plan?.includedUnits != null && unitAddon) {
      list += extraUnitsFor(units, plan.includedUnits) * Number(unitAddon.priceMonthly);
    }
    for (const a of addons) {
      // Los que el plan nuevo no admite se dan de baja al cambiar.
      if (a.addon.planSlugs.length > 0 && !(slug && a.addon.planSlugs.includes(slug))) continue;
      list += Number(a.priceMonthly) * a.quantity;
    }
    // Lo que se cobra de verdad: con IVA incluido o sumándolo.
    const amount = amountToCharge(list, pricing);
    return { amount, label: formatEur(amount) };
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
  /** A quién iría la propuesta de un extra (para la vista previa de un envío a varios). */
  async addonOfferRecipients(tenantId: string): Promise<string[]> {
    return this.recipientsFor(tenantId);
  }

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
    const recipients = await this.commercialRecipients(tenantId);
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
    // Es una oferta: cada propietario recibe la suya con su enlace de baja.
    const type = `addon_offer:${Date.now()}`;
    const subject = until
      ? `Prueba gratis de ${args.addonName} hasta el ${until}`
      : `${args.addonName} para ${args.tenantName}`;
    const sender = await this.repSender(tenantId, type);
    try {
      await this.admin.tenantLifecycleEmail.create({ data: { tenantId, type } });
    } catch {
      return 0;
    }
    await this.emailQueue.addBulk(
      recipients.map((r) => {
        const unsub = platformUnsubscribeFooter({
          key: this.unsubscribeKey,
          webBaseUrl: this.webBaseUrl,
          apiBaseUrl: this.apiBaseUrl,
          userId: r.userId,
        });
        const { html } = renderEmail(body);
        return {
          name: JOB_EMAIL_SEND,
          data: {
            to: r.email,
            kind: lifecycleKind(type),
            subject,
            html: `${html}<p style="font-family:system-ui,-apple-system,sans-serif;font-size:12px;color:#64748b;margin-top:24px">${unsub.footerHtml}</p>`,
            text: `${body}\n\n—\n${unsub.footerText}`,
            headers: unsub.headers,
            ...(sender ? { fromName: sender.fromName, replyTo: sender.replyTo } : {}),
          },
        };
      }),
    );
    return recipients.length;
  }

  /** A cuántos les llegaría una oferta (propietarios verificados sin la baja). */
  async addonOfferRecipients(tenantId: string): Promise<number> {
    return (await this.commercialRecipients(tenantId)).length;
  }

  /**
   * Destinatarios de una comunicación comercial: propietarios verificados y
   * activos que no se han dado de baja de las novedades y ofertas (nunca el
   * email de facturación, que no tiene enlace de baja).
   */
  private async commercialRecipients(
    tenantId: string,
  ): Promise<{ userId: string; email: string }[]> {
    const owners = await this.admin.user.findMany({
      where: {
        tenantId,
        role: 'owner',
        isActive: true,
        emailVerifiedAt: { not: null },
        platformNewsOptOutAt: null,
      },
      select: { id: true, email: true },
      orderBy: { createdAt: 'asc' },
    });
    const seen = new Set<string>();
    return owners.flatMap((o) => {
      const email = o.email.toLowerCase();
      if (seen.has(email)) return [];
      seen.add(email);
      return [{ userId: o.id, email }];
    });
  }

  /** Propuesta de cuota (plan + extras) con su desglose y el enlace para contratar. */
  async sendQuoteOffer(
    tenantId: string,
    args: {
      tenantName: string;
      quote: AdminQuoteDto;
      message: string | null;
      /** Enlace a Suscripción con el plan, el ciclo y el cupón ya elegidos. */
      acceptUrl?: string | null;
      /** La envía un comercial: sale a su nombre y las respuestas le llegan a él. */
      sender?: EmailSenderOverride;
    },
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
      `Aceptar la propuesta: ${args.acceptUrl ?? this.billingUrl}`,
      '',
      'Si tienes dudas, responde a este correo.',
      '',
      args.sender?.signature ?? 'El equipo de TrasterOS',
    ].join('\n');
    const sent = await this.dispatch(
      tenantId,
      `quote_offer:${Date.now()}`,
      {
        subject: `Tu propuesta de TrasterOS: ${money(q.total)} ${period}`,
        ...renderEmail(body),
      },
      args.sender ? { sender: args.sender } : {},
    );
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
        users: { some: { role: 'owner', emailVerifiedAt: { not: null } } },
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
      {
        type: 'activation_customer',
        after: 7,
        // El texto da por hecho que ya tiene el local.
        missing: (c: Counts) => c.facilities > 0 && c.customers === 0,
      },
      { type: 'activation_invoice', after: 12, missing: (c: Counts) => c.invoices === 0 },
    ] as const;
    let count = 0;
    for (const t of tenants) {
      const days = Math.floor((now.getTime() - t.createdAt.getTime()) / day);
      const sent = new Set(t.tenantLifecycleEmails.map((e) => e.type));
      // Solo el paso más avanzado que toca (si va con retraso no le llegan tres seguidos).
      const step = [...steps].reverse().find((s) => days >= s.after && s.missing(t._count));
      if (!step || sent.has(step.type)) continue;
      const tmpl = this.activationTemplate(t.name, step.type);
      if (await this.dispatch(t.id, step.type, tmpl, { verifiedOnly: true })) {
        count += 1;
        if (step.type === 'activation_invoice') {
          await this.admin.tenantFollowup.create({
            data: {
              tenantId: t.id,
              superAdminId: null,
              title: 'Llamar: lleva 12 días de prueba sin facturar',
              // Hoy en hora de España (no el día UTC).
              dueDate: todayInTimezone('Europe/Madrid', now),
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
  /** La bienvenida sale al activar la cuenta; el cron recoge lo que quedara pendiente. */
  @OnEvent(TENANT_OWNER_VERIFIED, { async: true, promisify: true })
  async onOwnerVerified({ tenantId }: { tenantId: string }): Promise<void> {
    try {
      const settings = await this.admin.platformAlertSettings.findFirst();
      if (!settings?.lifecycleEnabled || !settings.sendWelcome) return;
      const tenant = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, slug: true, billingExempt: true },
      });
      if (!tenant || tenant.billingExempt) return;
      await this.dispatch(
        tenantId,
        'welcome',
        await this.welcomeTemplate(tenant.name, tenant.slug),
        { verifiedOnly: true },
      );
    } catch (err) {
      this.logger.error(`bienvenida de ${tenantId}: ${(err as Error).message}`);
    }
  }

  private async runWelcome(): Promise<number> {
    const since = new Date(Date.now() - 7 * DAY_MS);
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        createdAt: { gte: since },
        users: { some: { role: 'owner', emailVerifiedAt: { not: null } } },
        tenantLifecycleEmails: { none: { type: 'welcome' } },
      },
      select: { id: true, name: true, slug: true },
    });
    let count = 0;
    for (const t of tenants) {
      const tmpl = await this.welcomeTemplate(t.name, t.slug);
      if (await this.dispatch(t.id, 'welcome', tmpl, { verifiedOnly: true })) count += 1;
    }
    return count;
  }

  /**
   * Cuentas sin activar: recordatorio con enlace nuevo a las 24 h y a las 72 h.
   * Salen siempre (sin ellos la cuenta no llega a usarse); uno por tipo y tenant.
   */
  async runVerificationReminders(now = new Date()): Promise<number> {
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        status: 'trial',
        createdAt: { lte: new Date(now.getTime() - DAY_MS) },
        users: { none: { emailVerifiedAt: { not: null } } },
      },
      select: {
        id: true,
        createdAt: true,
        tenantLifecycleEmails: { select: { type: true } },
        users: { where: { role: 'owner', isActive: true }, select: { id: true }, take: 1 },
      },
      take: 500,
    });
    let count = 0;
    for (const t of tenants) {
      const owner = t.users[0];
      if (!owner) continue;
      const sent = new Set(t.tenantLifecycleEmails.map((e) => e.type));
      const hours = (now.getTime() - t.createdAt.getTime()) / (60 * 60 * 1000);
      const type = hours >= 72 ? 'verify_reminder_2' : 'verify_reminder_1';
      if (sent.has(type)) continue;
      try {
        await this.admin.tenantLifecycleEmail.create({ data: { tenantId: t.id, type } });
      } catch {
        continue; // Otra réplica lo reservó.
      }
      await this.auth.sendVerificationReminder(t.id, owner.id, type === 'verify_reminder_2');
      count += 1;
    }
    return count;
  }

  /**
   * Borra las cuentas que nunca se activaron: libera el identificador y no
   * guarda datos de quien no llegó a usar el servicio. Solo a partir de los 30
   * días y con el último aviso enviado hace al menos 7; sin activar no se puede
   * entrar, así que no hay nada más que conservar. Si aun así tuviera datos, se
   * deja y se avisa en el registro.
   */
  async purgeUnverifiedAccounts(now = new Date()): Promise<number> {
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        status: 'trial',
        createdAt: { lte: new Date(now.getTime() - UNVERIFIED_PURGE_DAYS * DAY_MS) },
        users: { none: { emailVerifiedAt: { not: null } } },
        facilities: { none: {} },
        customers: { none: {} },
        tenantLifecycleEmails: {
          some: {
            type: 'verify_reminder_2',
            sentAt: { lte: new Date(now.getTime() - 7 * DAY_MS) },
          },
        },
      },
      select: { id: true, slug: true },
      take: 100,
    });
    let count = 0;
    for (const { id: tenantId, slug } of tenants) {
      try {
        const where = { tenantId };
        await this.admin.$transaction([
          this.admin.auditLog.deleteMany({ where }),
          this.admin.emailVerificationToken.deleteMany({ where }),
          this.admin.passwordResetToken.deleteMany({ where }),
          this.admin.session.deleteMany({ where }),
          this.admin.messageTemplate.deleteMany({ where }),
          this.admin.invoiceSeries.deleteMany({ where }),
          this.admin.tenantSubscription.deleteMany({ where }),
          this.admin.user.deleteMany({ where }),
          this.admin.tenant.delete({ where: { id: tenantId } }),
        ]);
        this.logger.log(`cuenta sin activar borrada: ${slug}`);
        count += 1;
      } catch (err) {
        this.logger.error(`no se pudo borrar la cuenta ${slug}: ${(err as Error).message}`);
      }
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
        select: {
          id: true,
          name: true,
          trialEndsAt: true,
          subscription: { select: { plan: { select: { name: true } } } },
        },
      });
      for (const t of tenants) {
        const limits = await this.trialPendingNote(t.id).catch(() => []);
        const quote = await this.monthlyQuote(t.id).catch(() => null);
        const tmpl = await this.templates.render('trial_ending', {
          empresa: t.name,
          dias: milestone.days === 1 ? '1 día' : `${milestone.days} días`,
          fecha: t.trialEndsAt ? formatDateLong(t.trialEndsAt) : '',
          plan: t.subscription?.plan.name ?? '',
          importe: quote?.label ?? '',
          enlace_pago: this.billingUrl,
          limites: limits.join('\n'),
        });
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
      if (await this.dispatch(t.id, 'past_due', await this.pastDueTemplate(t.name))) count += 1;
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
  private async dispatch(
    tenantId: string,
    type: string,
    tmpl: EmailTemplate,
    opts: { verifiedOnly?: boolean; sender?: EmailSenderOverride } = {},
  ): Promise<boolean> {
    const recipients = await this.recipientsFor(tenantId, opts.verifiedOnly);
    if (recipients.length === 0) return false;
    // Los correos de la prueba de un cliente de un comercial salen a su nombre.
    const sender = opts.sender ?? (await this.repSender(tenantId, type));

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
          ...(sender ? { fromName: sender.fromName, replyTo: sender.replyTo } : {}),
        },
      })),
    );
    return true;
  }

  /**
   * Remitente del comercial de la cuenta para los correos de la prueba y de
   * puesta en marcha (no para cobros ni impagos), si la dirección lo quiere.
   */
  private async repSender(tenantId: string, type: string): Promise<EmailSenderOverride | null> {
    if (!/^(welcome|trial_|trial-|nudge|activation|addon_offer|quote_offer)/.test(type))
      return null;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        salesRep: { select: { fullName: true, email: true, role: true, isActive: true } },
      },
    });
    const rep = tenant?.salesRep;
    if (!rep?.isActive || rep.role !== 'sales') return null;
    const settings = await this.admin.platformSalesSettings.findFirst({
      select: { lifecycleFromRep: true },
    });
    if (settings && !settings.lifecycleFromRep) return null;
    return {
      fromName: `${rep.fullName} · TrasterOS`,
      replyTo: { email: rep.email, name: rep.fullName },
    };
  }

  /**
   * Emails de destino de un tenant: owners verificados activos o billingEmail.
   * Lo que invita a usar el panel (`verifiedOnly`) solo va a quien puede entrar.
   */
  private async recipientsFor(tenantId: string, verifiedOnly = false): Promise<string[]> {
    const owners = await this.admin.user.findMany({
      where: { tenantId, role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
      select: { email: true },
    });
    const emails = new Set(owners.map((o) => o.email.toLowerCase()));
    if (emails.size === 0 && !verifiedOnly) {
      const tenant = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { billingEmail: true },
      });
      if (tenant?.billingEmail) emails.add(tenant.billingEmail.toLowerCase());
    }
    return [...emails];
  }

  // --- Plantillas (español, tono cordial de operador SaaS) ---

  /** Lo que aún le falta para sacarle partido, según lo que tiene de verdad. */
  private async trialPendingNote(tenantId: string): Promise<string[]> {
    const [ready, units, contracts] = await Promise.all([
      tenantReadiness(this.admin, tenantId),
      this.admin.unit.count({ where: { tenantId } }),
      this.admin.contract.count({ where: { tenantId, deletedAt: null, signedAt: { not: null } } }),
    ]);
    const pending = [
      ...(ready.hasFacility ? [] : ['crear tu primer local']),
      ...(units > 0 ? [] : ['dar de alta tus trasteros']),
      ...(ready.hasCompany ? [] : ['completar los datos de tu empresa']),
      ...(ready.hasPayment ? [] : ['elegir cómo te pagan tus inquilinos']),
      ...(contracts > 0 ? [] : ['firmar tu primer contrato']),
    ];
    if (pending.length === 0) return [];
    return [`Antes de que termine te falta: ${pending.join(', ')}.`];
  }

  // Textos editables desde el panel admin (Comunicación → Correos automáticos).

  private welcomeTemplate(tenantName: string, slug: string): Promise<EmailTemplate> {
    const base = this.billingUrl.replace('/settings/saas-billing', '');
    return this.templates.render('welcome', {
      empresa: tenantName,
      identificador: slug,
      enlace_panel: `${base}/dashboard`,
      enlace_web: `${base}/s/${slug}`,
    });
  }

  private pastDueTemplate(tenantName: string): Promise<EmailTemplate> {
    return this.templates.render('past_due', { empresa: tenantName, enlace_pago: this.billingUrl });
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

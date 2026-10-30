import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { formatDateLong } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';

import { periodsOwed, subscriptionDueDate } from './platform-due';
import { dunningMessage } from './platform-dunning-message';
import { amountToCharge, platformPricing } from './platform-pricing';

import type { Env } from '../../config/env.schema';
import type {
  DunningRunResultDto,
  PlatformDunningSettingsDto,
  UpdatePlatformDunningSettingsInput,
} from '@storageos/shared';

const MODE_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  sepa: 'domiciliación SEPA',
  redsys: 'cobro con tarjeta',
  manual: 'pago a mano',
};
const DAY_MS = 24 * 60 * 60 * 1000;
/** Un cobro automático de Redsys sin respuesta se da por en curso este tiempo. */
const REDSYS_IN_FLIGHT_MS = 48 * 60 * 60 * 1000;

/**
 * Dunning del SaaS: cobra a los tenants morosos de la suscripción. Detecta las
 * suscripciones `past_due`, envía recordatorios escalados por email y suspende
 * el tenant tras N días de impago. Idempotente por ciclo (period_end).
 */
@Injectable()
export class PlatformDunningService {
  private readonly logger = new Logger(PlatformDunningService.name);
  private readonly webBaseUrl: string;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true });
  }

  async getSettings(): Promise<PlatformDunningSettingsDto> {
    let row = await this.admin.platformDunningSettings.findFirst();
    row ??= await this.admin.platformDunningSettings.create({ data: {} });
    return {
      enabled: row.enabled,
      reminder1Days: row.reminder1Days,
      reminder2Days: row.reminder2Days,
      suspendDays: row.suspendDays,
    };
  }

  async updateSettings(
    input: UpdatePlatformDunningSettingsInput,
  ): Promise<PlatformDunningSettingsDto> {
    const existing = await this.admin.platformDunningSettings.findFirst();
    const data = {
      enabled: input.enabled,
      reminder1Days: input.reminder1Days,
      reminder2Days: input.reminder2Days,
      suspendDays: input.suspendDays,
    };
    const row = existing
      ? await this.admin.platformDunningSettings.update({ where: { id: existing.id }, data })
      : await this.admin.platformDunningSettings.create({ data });
    return {
      enabled: row.enabled,
      reminder1Days: row.reminder1Days,
      reminder2Days: row.reminder2Days,
      suspendDays: row.suspendDays,
    };
  }

  /**
   * Enforcement de pagos MANUALES (sin Stripe): marca `past_due` las suscripciones
   * de un plan de pago cuyo periodo ya venció y siguen `active`. Con Stripe el
   * `past_due` lo pone el webhook; los manuales no tienen webhook, así que sin
   * esto un moroso manual seguiría operando indefinidamente. Se ejecuta SIEMPRE
   * (aunque el dunning escalado esté desactivado) para que al tenant le aparezca
   * el banner de impago desde el primer día. Excluye exentos, `free` y bajas.
   *
   * `updateMany` no filtra por relaciones → resolvemos ids con `findMany` primero.
   */
  async markLapsedManualPastDue(now = new Date()): Promise<number> {
    const lapsed = await this.admin.tenantSubscription.findMany({
      where: {
        status: 'active',
        stripeSubscriptionId: null, // pago manual (transferencia/efectivo)
        currentPeriodEnd: { lt: now },
        plan: { priceMonthly: { gt: 0 } }, // planes de pago (free no se cobra)
        tenant: { deletedAt: null, billingExempt: false, status: { not: 'suspended' } },
      },
      select: { id: true, tenantId: true, billingMode: true },
    });
    if (lapsed.length === 0) return 0;
    // Domiciliación SEPA con el adeudo ya en una remesa: el cobro está en el
    // banco (se confirma al liquidarse), no es un impago.
    const inFlight = await this.tenantsWithChargeInFlight(lapsed, now);
    const due = lapsed.filter((s) => !inFlight.has(s.tenantId));
    if (due.length === 0) return 0;
    await this.admin.tenantSubscription.updateMany({
      where: { id: { in: due.map((s) => s.id) } },
      data: { status: 'past_due' },
    });
    this.logger.log(`Enforcement manual: ${due.length} suscripciones a past_due por impago`);
    return due.length;
  }

  /**
   * Avisos al super admin (una vez por impago o cada 30 días):
   * - un tenant pasa a «pago pendiente» (por cualquier forma de cobro);
   * - una cuenta exenta o anonimizada sigue domiciliada o con la tarjeta
   *   guardada (no se le cobra, pero conviene pasarla a pago a mano).
   */
  async notifyBillingAlerts(now = new Date()): Promise<{ pastDue: number; misconfigured: number }> {
    const [pastDue, misconfigured] = await Promise.all([
      this.admin.tenantSubscription.findMany({
        where: {
          status: 'past_due',
          plan: { priceMonthly: { gt: 0 } },
          tenant: { deletedAt: null, billingExempt: false },
        },
        include: { tenant: { select: { name: true } } },
      }),
      this.admin.tenantSubscription.findMany({
        where: {
          billingMode: { in: ['sepa', 'redsys'] },
          OR: [{ tenant: { billingExempt: true } }, { tenant: { deletedAt: { not: null } } }],
        },
        include: { tenant: { select: { name: true, billingExempt: true, deletedAt: true } } },
      }),
    ]);
    let pastDueSent = 0;
    for (const sub of pastDue) {
      const since = subscriptionDueDate(sub);
      const link = `/admin/tenants/${sub.tenantId}?tab=payments`;
      const already = await this.admin.superAdminNotification.findFirst({
        where: { type: 'platform_billing.past_due', link, createdAt: { gte: since } },
        select: { id: true },
      });
      if (already) continue;
      await this.admin.superAdminNotification.create({
        data: {
          type: 'platform_billing.past_due',
          title: `${sub.tenant.name} tiene la cuota pendiente de pago`,
          body: `Desde el ${formatDateLong(since)} (${MODE_LABEL[sub.billingMode] ?? sub.billingMode}).`,
          link,
        },
      });
      pastDueSent += 1;
    }
    let miscSent = 0;
    const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
    for (const sub of misconfigured) {
      const link = `/admin/tenants/${sub.tenantId}?tab=payments`;
      const already = await this.admin.superAdminNotification.findFirst({
        where: { type: 'platform_billing.mode_mismatch', link, createdAt: { gte: monthAgo } },
        select: { id: true },
      });
      if (already) continue;
      const why = sub.tenant.deletedAt ? 'está anonimizada' : 'está exenta de pago';
      await this.admin.superAdminNotification.create({
        data: {
          type: 'platform_billing.mode_mismatch',
          title: `${sub.tenant.name} ${why} pero sigue en ${MODE_LABEL[sub.billingMode]}`,
          body: 'No se le cobra nada, pero conviene pasarla a pago a mano para que no aparezca en los cobros.',
          link,
        },
      });
      miscSent += 1;
    }
    return { pastDue: pastDueSent, misconfigured: miscSent };
  }

  /**
   * Tenants con un cobro de la cuota en marcha: un adeudo SEPA en una remesa
   * viva, o un cobro automático de Redsys cuya respuesta aún no ha llegado
   * (lo aplica el aviso del banco). Mientras tanto no es un impago.
   */
  private async tenantsWithChargeInFlight(
    subs: { tenantId: string; billingMode: string }[],
    now: Date,
  ): Promise<Set<string>> {
    const sepa = await this.tenantsWithPendingSepa(
      subs.filter((s) => s.billingMode === 'sepa').map((s) => s.tenantId),
    );
    const redsysIds = subs.filter((s) => s.billingMode === 'redsys').map((s) => s.tenantId);
    if (redsysIds.length === 0) return sepa;
    const charging = await this.admin.platformRedsysOrder.findMany({
      where: {
        tenantId: { in: redsysIds },
        status: 'charging',
        createdAt: { gte: new Date(now.getTime() - REDSYS_IN_FLIGHT_MS) },
      },
      select: { tenantId: true },
    });
    for (const c of charging) sepa.add(c.tenantId);
    return sepa;
  }

  /** Tenants con un adeudo SEPA de plataforma pendiente en una remesa viva. */
  private async tenantsWithPendingSepa(tenantIds: string[]): Promise<Set<string>> {
    if (tenantIds.length === 0) return new Set();
    const items = await this.admin.platformSepaRemittanceItem.findMany({
      where: {
        tenantId: { in: tenantIds },
        itemStatus: 'pending',
        remittance: { status: { not: 'cancelled' } },
      },
      select: { tenantId: true },
    });
    return new Set(items.map((i) => i.tenantId));
  }

  /** Evalúa las suscripciones morosas y ejecuta los pasos que toquen. */
  async run(now = new Date()): Promise<DunningRunResultDto> {
    const settings = await this.getSettings();
    const result: DunningRunResultDto = { evaluated: 0, reminders: 0, suspended: 0 };
    if (!settings.enabled) return result;

    // Solo tenants operando con un plan de pago: no se escala a quien está de
    // baja, borrado, suspendido a mano (su motivo y fecha de baja se respetan),
    // en prueba (su primer cobro de Stripe lo sigue reintentando Stripe) ni a
    // quien se pasó a un plan gratis.
    const subs = await this.admin.tenantSubscription.findMany({
      where: {
        status: 'past_due',
        plan: { priceMonthly: { gt: 0 } },
        tenant: { billingExempt: false, deletedAt: null, status: 'active' },
      },
      include: { plan: { select: { name: true } }, tenant: true },
    });
    // Con el cobro en marcha (adeudo en el banco o cobro de Redsys sin
    // respuesta) no se recuerda ni se suspende mientras se resuelve.
    const inFlight = await this.tenantsWithChargeInFlight(subs, now);

    for (const sub of subs) {
      if (inFlight.has(sub.tenantId)) continue;
      // `currentPeriodEnd` YA incluye el crédito manual acumulado (lo suman tanto
      // `recordManualPayment` como `syncSubscriptionFromStripe`); NO se vuelve a
      // sumar aquí o el dunning tardaría el doble en actuar sobre morosos con
      // histórico de pagos manuales.
      const periodEnd = sub.currentPeriodEnd;
      const daysOverdue = Math.floor((now.getTime() - subscriptionDueDate(sub).getTime()) / DAY_MS);
      if (daysOverdue < 0) continue;
      result.evaluated += 1;

      const steps: { step: string; threshold: number; suspend?: boolean }[] = [
        { step: 'reminder_1', threshold: settings.reminder1Days },
        { step: 'reminder_2', threshold: settings.reminder2Days },
        { step: 'suspend', threshold: settings.suspendDays, suspend: true },
      ];

      for (const s of steps) {
        if (daysOverdue < s.threshold) continue;
        // Idempotencia: no repetir el paso en este ciclo (tenant, step, periodEnd).
        try {
          await this.admin.platformDunningEvent.create({
            data: { tenantId: sub.tenantId, step: s.step, periodEnd },
          });
        } catch {
          continue; // ya ejecutado en este ciclo
        }

        if (s.suspend) {
          if (await this.suspend(sub.tenantId)) {
            result.suspended += 1;
            await this.notify(sub.tenantId, true, now).catch(() => 0);
          }
        } else {
          result.reminders += 1;
          await this.notify(sub.tenantId, false, now).catch(() => 0);
        }
      }
    }
    if (result.reminders || result.suspended) {
      this.logger.log(
        `Dunning: ${result.reminders} recordatorios, ${result.suspended} suspensiones (de ${result.evaluated})`,
      );
    }
    return result;
  }

  private async suspend(tenantId: string): Promise<boolean> {
    // La suspensión es a nivel de tenant (el enum `SubscriptionStatus` no tiene
    // 'suspended'); la suscripción se queda en `past_due`. Baja por impago → se
    // registra el motivo para el reporte de churn por razón.
    // Solo si sigue activo: no pisa una suspensión o una baja hechas a mano
    // entre la lectura y este paso.
    const { count } = await this.admin.tenant.updateMany({
      where: { id: tenantId, status: 'active', deletedAt: null },
      data: { status: 'suspended', churnReason: 'nonpayment', canceledAt: new Date() },
    });
    return count === 1;
  }

  /**
   * Destinatarios de los avisos: el email de facturación y los propietarios
   * con el email verificado (el de facturación puede estar vacío o ser de
   * una gestoría que no lo lee).
   */
  private async recipients(tenantId: string, billingEmail: string | null): Promise<string[]> {
    const owners = await this.admin.user.findMany({
      where: { tenantId, role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
      select: { email: true },
    });
    const all = [billingEmail, ...owners.map((o) => o.email)]
      .filter((e): e is string => !!e)
      .map((e) => e.toLowerCase());
    return [...new Set(all)];
  }

  /**
   * Aviso de impago con lo que debe de verdad (cada cuota vencida, plan más
   * los extras que van en el mismo cargo) y cómo pagarlo según su forma de
   * cobro. Devuelve a cuántas direcciones salió.
   */
  private async notify(tenantId: string, suspended: boolean, now = new Date()): Promise<number> {
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: {
        plan: { select: { name: true, priceMonthly: true } },
        tenant: {
          select: {
            name: true,
            billingEmail: true,
            subscriptionAddons: {
              where: { suspendedAt: null },
              select: { priceMonthly: true, quantity: true, billingMode: true },
            },
          },
        },
      },
    });
    if (!sub) return 0;
    const to = await this.recipients(tenantId, sub.tenant.billingEmail);
    if (to.length === 0) {
      // Sin nadie a quien avisar: que no quede en silencio.
      await this.admin.superAdminNotification
        .create({
          data: {
            type: 'platform_dunning.no_recipient',
            title: `Sin email para avisar del impago de ${sub.tenant.name}`,
            body: 'No tiene email de facturación ni propietarios con el email verificado: el aviso de impago no ha salido.',
            link: `/admin/tenants/${tenantId}?tab=payments`,
          },
        })
        .catch(() => undefined);
      return 0;
    }
    const withPlan = sub.billingMode === 'sepa' || sub.billingMode === 'redsys';
    const addons = withPlan
      ? sub.tenant.subscriptionAddons
          .filter((a) => a.billingMode !== 'stripe')
          .reduce((sum, a) => sum + Number(a.priceMonthly) * a.quantity, 0)
      : 0;
    const perPeriod = amountToCharge(
      Number(sub.plan.priceMonthly) + addons,
      await platformPricing(this.admin),
    );
    const since = subscriptionDueDate(sub);
    const periods = periodsOwed(
      since,
      now,
      1,
      sub.billingMode === 'stripe' && !!sub.stripeSubscriptionId,
    );
    const [lastSepa, card] = await Promise.all([
      sub.billingMode === 'sepa'
        ? this.admin.platformSepaRemittanceItem.findFirst({
            where: { tenantId },
            orderBy: { periodCovered: 'desc' },
            select: { itemStatus: true },
          })
        : null,
      sub.billingMode === 'redsys'
        ? this.admin.platformRedsysCard.findUnique({
            where: { tenantId },
            select: { lastError: true },
          })
        : null,
    ]);
    const message = dunningMessage({
      tenantName: sub.tenant.name,
      planName: sub.plan.name,
      amount: Math.round(perPeriod * periods * 100) / 100,
      periods,
      since,
      daysOverdue: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS)),
      billingMode: sub.billingMode,
      sepaBounced: lastSepa?.itemStatus === 'bounced',
      cardError: card?.lastError ?? null,
      suspended,
      link: `${this.webBaseUrl}/settings/saas-billing`,
    });
    for (const email of to) {
      await this.email.sendRendered({ to: email, kind: 'payment_pending', ...message });
    }
    return to.length;
  }

  /**
   * «Enviar recordatorio ahora» desde Cobros pendientes: el mismo aviso del
   * escalado, sin contar como paso (no adelanta la suspensión).
   */
  async remindNow(tenantId: string): Promise<{ recipients: number }> {
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      select: { status: true, tenant: { select: { status: true, billingExempt: true } } },
    });
    if (!sub || sub.tenant.billingExempt || sub.status !== 'past_due') {
      throw new BadRequestException({
        code: 'nothing_overdue',
        message: 'Este tenant no tiene la cuota pendiente de pago.',
      });
    }
    const recipients = await this.notify(tenantId, sub.tenant.status === 'suspended');
    return { recipients };
  }
}

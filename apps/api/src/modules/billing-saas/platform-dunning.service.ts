import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';

import type {
  DunningRunResultDto,
  PlatformDunningSettingsDto,
  UpdatePlatformDunningSettingsInput,
} from '@storageos/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Dunning del SaaS: cobra a los tenants morosos de la suscripción. Detecta las
 * suscripciones `past_due`, envía recordatorios escalados por email y suspende
 * el tenant tras N días de impago. Idempotente por ciclo (period_end).
 */
@Injectable()
export class PlatformDunningService {
  private readonly logger = new Logger(PlatformDunningService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
  ) {}

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

  /** Evalúa las suscripciones morosas y ejecuta los pasos que toquen. */
  async run(now = new Date()): Promise<DunningRunResultDto> {
    const settings = await this.getSettings();
    const result: DunningRunResultDto = { evaluated: 0, reminders: 0, suspended: 0 };
    if (!settings.enabled) return result;

    const subs = await this.admin.tenantSubscription.findMany({
      where: { status: 'past_due' },
      include: { plan: { select: { name: true } }, tenant: true },
    });

    for (const sub of subs) {
      // `currentPeriodEnd` YA incluye el crédito manual acumulado (lo suman tanto
      // `recordManualPayment` como `syncSubscriptionFromStripe`); NO se vuelve a
      // sumar aquí o el dunning tardaría el doble en actuar sobre morosos con
      // histórico de pagos manuales.
      const periodEnd = sub.currentPeriodEnd;
      const daysOverdue = Math.floor((now.getTime() - periodEnd.getTime()) / DAY_MS);
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
          await this.suspend(sub.tenantId);
          result.suspended += 1;
          await this.notify(sub, daysOverdue, true).catch(() => undefined);
        } else {
          result.reminders += 1;
          await this.notify(sub, daysOverdue, false).catch(() => undefined);
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

  private async suspend(tenantId: string): Promise<void> {
    // La suspensión es a nivel de tenant (el enum `SubscriptionStatus` no tiene
    // 'suspended'); la suscripción se queda en `past_due`.
    await this.admin.tenant.update({ where: { id: tenantId }, data: { status: 'suspended' } });
  }

  private async notify(
    sub: { tenant: { name: string; billingEmail: string | null }; plan: { name: string } | null },
    daysOverdue: number,
    suspended: boolean,
  ): Promise<void> {
    const to = sub.tenant.billingEmail;
    if (!to) return;
    const subject = suspended
      ? 'Tu cuenta de StorageOS ha sido suspendida por impago'
      : 'Recordatorio de pago de tu suscripción StorageOS';
    const body = suspended
      ? `<p>Hola,</p><p>Tu suscripción a StorageOS lleva ${daysOverdue} días impagada y hemos <strong>suspendido</strong> tu cuenta. Regulariza el pago para reactivarla.</p>`
      : `<p>Hola,</p><p>Tu suscripción a StorageOS (${sub.plan?.name ?? 'plan'}) tiene un pago pendiente desde hace ${daysOverdue} días. Por favor, regulariza el pago para evitar la suspensión del servicio.</p>`;
    await this.email.sendRendered({
      to,
      subject,
      html: body,
      text: body.replace(/<[^>]+>/g, ''),
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Cron diario de las renovaciones de los canales (suscripción a un portal,
 * campaña con fecha fija…):
 * 1. Un canal que se renueva cada N meses y ya pasó su fecha pasa a la
 *    siguiente (sin esto se quedaba en el pasado y no volvía a avisar).
 * 2. Avisa a quien ve Marketing cuando faltan 7 días o menos para renovar, una
 *    vez por fecha (aunque el cron no corriera justo el día −7, o el canal se
 *    creara con menos de 7 días de margen).
 * Solo canales activos de negocios en marcha. Ligero y sin BullMQ → corre en
 * el API (patrón `claimDailyCronRun`).
 */
@Injectable()
export class MarketingRenewalsCron {
  private readonly logger = new Logger(MarketingRenewalsCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 7 * * *', { name: 'marketing-renewals.daily' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'marketing-renewals.daily'))) return;
      await this.run();
    } catch (err) {
      this.logger.error(
        `Cron de avisos de renovación de marketing falló: ${(err as Error).message}`,
      );
    }
  }

  /** Avanza las fechas vencidas y avisa de las próximas. Devuelve los avisos enviados. */
  async run(now = new Date()): Promise<number> {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const horizon = new Date(today.getTime() + 7 * 86_400_000);
    const liveTenant = { deletedAt: null, status: { not: 'cancelled' as const } };

    const overdue = await this.admin.marketingChannel.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        renewalMonths: { not: null },
        renewsOn: { lt: today },
        tenant: liveTenant,
      },
      select: { id: true, renewsOn: true, renewalMonths: true },
    });
    for (const c of overdue) {
      const next = new Date(c.renewsOn!);
      while (next < today) next.setUTCMonth(next.getUTCMonth() + c.renewalMonths!);
      await this.admin.marketingChannel.updateMany({
        // Solo si nadie la ha cambiado entretanto.
        where: { id: c.id, renewsOn: c.renewsOn },
        data: { renewsOn: next, renewalNotifiedOn: null },
      });
    }

    const due = await this.admin.marketingChannel.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        renewsOn: { gte: today, lte: horizon },
        tenant: liveTenant,
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        facilityId: true,
        renewsOn: true,
        renewalNotifiedOn: true,
      },
    });
    let sent = 0;
    for (const c of due) {
      if (c.renewalNotifiedOn && c.renewalNotifiedOn.getTime() === c.renewsOn!.getTime()) continue;
      // Reserva el aviso de esta fecha antes de enviarlo (nunca dos).
      const claimed = await this.admin.marketingChannel.updateMany({
        where: {
          id: c.id,
          renewsOn: c.renewsOn,
          OR: [{ renewalNotifiedOn: null }, { renewalNotifiedOn: { not: c.renewsOn! } }],
        },
        data: { renewalNotifiedOn: c.renewsOn },
      });
      if (claimed.count === 0) continue;
      const days = Math.round((c.renewsOn!.getTime() - today.getTime()) / 86_400_000);
      try {
        await this.notifications.createForPermission(c.tenantId, 'marketing:read', {
          type: 'marketing.channel_renewing_soon',
          title:
            days === 0
              ? `«${c.name}» se renueva hoy`
              : `«${c.name}» se renueva en ${days} ${days === 1 ? 'día' : 'días'}`,
          body: 'Revisa lo que ha traído antes de que se renueve.',
          link: '/marketing/performance',
          facilityId: c.facilityId,
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(`Aviso de renovación falló para canal ${c.id}: ${(err as Error).message}`);
      }
    }
    return sent;
  }
}

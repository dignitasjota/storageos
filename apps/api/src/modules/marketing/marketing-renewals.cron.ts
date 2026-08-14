import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Cron diario: avisa (notificación in-app al staff) cuando un canal de
 * marketing activo renueva (suscripción de un portal inmobiliario, campaña
 * con fecha fija…) en exactamente 7 días — un único aviso por canal, sin
 * spam diario mientras dura la ventana (la propia sección de «Hoy» ya
 * muestra el recordatorio continuamente durante esos 7 días).
 * Ligero y sin BullMQ → corre en el API (patrón `claimDailyCronRun`, mismo
 * criterio que `ExpensesRecurringCron`).
 */
@Injectable()
export class MarketingRenewalsCron {
  private readonly logger = new Logger(MarketingRenewalsCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 7 * * *')
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'marketing-renewals.daily'))) return;
      const now = new Date();
      const dayStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const target = new Date(dayStart.getTime() + 7 * 86_400_000);
      const targetEnd = new Date(target.getTime() + 86_400_000);

      const due = await this.admin.marketingChannel.findMany({
        where: { deletedAt: null, status: 'active', renewsOn: { gte: target, lt: targetEnd } },
        select: { id: true, tenantId: true, name: true },
      });

      for (const c of due) {
        try {
          await this.notifications.create(c.tenantId, {
            type: 'marketing.channel_renewing_soon',
            title: `«${c.name}» renueva en 7 días`,
            body: 'Revisa el canal antes de que se renueve automáticamente.',
            link: '/marketing/channels',
          });
        } catch (err) {
          this.logger.warn(
            `Aviso de renovación falló para canal ${c.id}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Cron de avisos de renovación de marketing falló: ${(err as Error).message}`,
      );
    }
  }
}

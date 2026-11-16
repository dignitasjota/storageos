import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Los lunes, aviso a quien lleva el chat de la web con las respuestas que los
 * visitantes marcaron con 👎 la semana pasada (para corregir las preguntas
 * frecuentes o las indicaciones). Ligero: corre en el API, una vez al día.
 */
@Injectable()
export class WebChatWeeklyCron {
  private readonly logger = new Logger(WebChatWeeklyCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('15 9 * * 1', { name: 'web-chat.weekly-ratings', timeZone: 'Europe/Madrid' })
  async weekly(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'web-chat.weekly-ratings'))) return;
      await this.run();
    } catch (err) {
      this.logger.error(`Resumen semanal del chat falló: ${(err as Error).message}`);
    }
  }

  /** Avisos enviados. */
  async run(now = new Date()): Promise<number> {
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const rows = await this.admin.webChatMessage.groupBy({
      by: ['tenantId'],
      where: {
        rating: -1,
        role: 'assistant',
        createdAt: { gte: since },
        tenant: { deletedAt: null, status: { notIn: ['cancelled', 'suspended'] } },
      },
      _count: { _all: true },
    });
    let sent = 0;
    for (const r of rows) {
      const n = r._count._all;
      try {
        await this.notifications.createForPermission(r.tenantId, 'marketing:read', {
          type: 'web_chat.weekly_ratings',
          title:
            n === 1
              ? 'Una respuesta del chat de tu web no gustó esta semana'
              : `${n} respuestas del chat de tu web no gustaron esta semana`,
          body: 'Revísalas y añade lo que faltaba a las preguntas frecuentes o a las indicaciones del asistente.',
          link: '/marketing/web-chat',
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(`Resumen del chat de ${r.tenantId}: ${(err as Error).message}`);
      }
    }
    return sent;
  }
}

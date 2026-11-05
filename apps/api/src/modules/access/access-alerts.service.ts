import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';
import { QUEUE_BILLING } from '../queues/queues.module';

import type { Queue } from 'bullmq';

export type AccessAlertKind = 'cutAttempt' | 'repeatedFailures' | 'nightAttempt' | 'deviceOffline';

/** Una misma persona o puerta no vuelve a avisar en este plazo. */
const ALERT_WINDOW_SECONDS = 6 * 60 * 60;

/** Avisos de seguridad al equipo, con el interruptor de cada negocio. Nunca lanzan. */
@Injectable()
export class AccessAlertsService {
  private readonly logger = new Logger(AccessAlertsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
  ) {}

  async notify(
    tenantId: string,
    kind: AccessAlertKind,
    key: string,
    notification: {
      type: string;
      title: string;
      body: string;
      link: string;
      facilityId?: string | null;
    },
  ): Promise<void> {
    try {
      const tenant = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { accessAlerts: true },
      });
      const settings = (tenant?.accessAlerts ?? {}) as Partial<Record<AccessAlertKind, boolean>>;
      if (settings[kind] === false) return;
      const client = await this.queue.client;
      const claimed = await client.set(
        `acc:alert:${tenantId}:${kind}:${key}`,
        '1',
        'EX',
        ALERT_WINDOW_SECONDS,
        'NX',
      );
      if (claimed !== 'OK') return;
      await this.notifications.create(tenantId, notification);
    } catch (err) {
      this.logger.warn(`[access] aviso ${kind} no enviado: ${String(err)}`);
    }
  }
}

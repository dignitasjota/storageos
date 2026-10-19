import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { ChatAlertsService } from './chat-alerts.service';

/** Cada mañana (08:15), lo urgente del «Hoy» por Telegram/Slack. */
@Injectable()
export class ChatAlertsCron {
  private readonly logger = new Logger(ChatAlertsCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly chat: ChatAlertsService,
  ) {}

  @Cron('15 8 * * *', { name: 'chat-alerts.daily', timeZone: 'Europe/Madrid' })
  async run(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'chat-alerts.daily'))) return;
      const res = await this.chat.sendDaily();
      if (res.sent) this.logger.log('chat-alerts.daily: aviso enviado');
    } catch (err) {
      this.logger.error(`chat-alerts.daily fallo: ${(err as Error).message}`);
    }
  }

  /** Cada hora, las novedades comerciales de los tenants (si está activado). */
  @Cron('5 * * * *', { name: 'chat-alerts.commercial' })
  async commercial(): Promise<void> {
    try {
      const res = await this.chat.sendCommercial();
      if (res.sent) this.logger.log('chat-alerts.commercial: aviso enviado');
    } catch (err) {
      this.logger.error(`chat-alerts.commercial fallo: ${(err as Error).message}`);
    }
  }
}

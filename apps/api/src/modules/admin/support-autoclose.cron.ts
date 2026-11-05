import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import {
  ADMIN_MESSAGE_AUTO_CLOSE_DAYS,
  UNANSWERED_ADMIN_MESSAGE,
} from '../../common/support-ticket-filters';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SupportTicketsService } from './support-tickets.service';

/**
 * Cierra los mensajes que escribió el super admin y el tenant no contestó en
 * 14 días: eran avisos y no deben quedarse «esperando tu respuesta» para
 * siempre. Si el tenant contesta antes, es una conversación normal.
 */
@Injectable()
export class SupportAutoCloseCron {
  private readonly logger = new Logger(SupportAutoCloseCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tickets: SupportTicketsService,
  ) {}

  @Cron('20 5 * * *', { name: 'support.admin-messages-autoclose' })
  async handle(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'support.admin-messages-autoclose'))) return;
      const closed = await this.run();
      if (closed > 0) this.logger.log(`[support] mensajes del admin cerrados: ${closed}`);
      const waiting = await this.tickets.remindWaiting();
      if (waiting.reminded + waiting.closed > 0) {
        this.logger.log(
          `[support] esperando al tenant: ${waiting.reminded} recordados, ${waiting.closed} cerrados`,
        );
      }
    } catch (err) {
      this.logger.error(`[support] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async run(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - ADMIN_MESSAGE_AUTO_CLOSE_DAYS * 86_400_000);
    const res = await this.admin.supportTicket.updateMany({
      where: { ...UNANSWERED_ADMIN_MESSAGE, status: 'waiting_user', createdAt: { lt: before } },
      data: { status: 'closed', closedAt: now },
    });
    return res.count;
  }
}

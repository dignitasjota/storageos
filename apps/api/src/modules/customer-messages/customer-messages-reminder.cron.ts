import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CustomerMessagesService } from './customer-messages.service';

/** Cada hora: recuerda las conversaciones que llevan un día sin respuesta. */
@Injectable()
export class CustomerMessagesReminderCron {
  private readonly logger = new Logger(CustomerMessagesReminderCron.name);

  constructor(private readonly messages: CustomerMessagesService) {}

  @Cron('20 * * * *', { name: 'customer-messages.unanswered' })
  async run(): Promise<void> {
    try {
      const sent = await this.messages.remindUnanswered();
      if (sent > 0) this.logger.log(`Recordatorios de mensajes sin respuesta: ${sent}`);
    } catch (err) {
      this.logger.error(`customer-messages.unanswered: ${(err as Error).message}`);
    }
  }
}
